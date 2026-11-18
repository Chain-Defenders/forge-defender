import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec } from "../core/exec";
import { links } from "../core/links";
import { tool } from "../core/tools";
import { runInTerminal } from "../chain/terminal";
import {
  allowedFromConfig,
  BlockedHost,
  blockedHosts,
  Doctor,
  DoctorTool,
  editorTools,
  mergeKeys,
  parseDoctorJson,
  parseDoctorText,
  parseLog,
  parseScan,
  PlainKey,
} from "./report";

// The keymoat view: whether keymoat is installed and working, whether the tools VS Code starts go through it (only
// then are tests run from the editor sandboxed), wallet keys in plain text, and hosts it blocked for this project.
// Everything comes from keymoat's own commands, run from the extension host's environment, which is what matters:
// a terminal can have keymoat first on its PATH while VS Code itself does not.

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; doctor: Doctor; tools: DoctorTool[]; keys: PlainKey[]; keysError?: string; blocked: BlockedHost[] };

type Node =
  | { t: "info"; label: string; description?: string; tooltip?: string; icon: string; color?: string; command?: vscode.Command }
  | { t: "group"; id: string; label: string; description?: string; tooltip?: string; icon: string; color?: string; children: Node[] }
  | { t: "key"; key: PlainKey }
  | { t: "host"; host: BlockedHost };

const shimmable = ["forge", "cast", "anchor", "solana"] as const;

export function register(ctx: Ctx): void {
  const view = new KeymoatView(ctx);
  const tree = vscode.window.createTreeView("forgeDefender.keymoat", { treeDataProvider: view });
  // For the editor tests: what the view shows, without the tree.
  ctx.api.set("keymoat", {
    snapshot: async () => {
      await view.settled();
      return view.snapshot();
    },
  });
  ctx.subscriptions.push(
    tree,
    view,
    vscode.commands.registerCommand("forgeDefender.keymoat.refresh", () => view.refresh()),
    vscode.commands.registerCommand("forgeDefender.keymoat.openKey", (k: PlainKey) => openKey(k)),
    vscode.commands.registerCommand("forgeDefender.keymoat.moveKey", (n: Node | PlainKey) => moveKey(ctx, n)),
    vscode.commands.registerCommand("forgeDefender.keymoat.allowHost", (n: Node | BlockedHost) => view.allow(n)),
    vscode.commands.registerCommand("forgeDefender.keymoat.useLinks", () => view.useLinks()),
    vscode.commands.registerCommand("forgeDefender.keymoat.openDocs", () => vscode.env.openExternal(vscode.Uri.parse(links.keymoat))),
    ctx.onDidRunFoundryTests(() => view.refresh()),
    ctx.onDidChangeProjects(() => view.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgeDefender.paths")) view.refresh();
    }),
  );
  view.refresh();
}

class KeymoatView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private state: State = { kind: "loading" };
  private running?: Promise<void>;
  private again = false;

  constructor(private readonly ctx: Ctx) {}

  dispose() {
    this.changed.dispose();
  }

  refresh(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.load()
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        this.state = { kind: "error", message };
        this.ctx.log.error(`keymoat: ${message}`);
      })
      .finally(() => {
        this.running = undefined;
        this.changed.fire();
        if (this.again) {
          this.again = false;
          this.refresh();
        }
      });
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  snapshot() {
    const s = this.state;
    if (s.kind !== "ready") return { state: s.kind, message: s.kind === "error" ? s.message : undefined };
    return {
      state: s.kind,
      legacy: s.doctor.legacy,
      sandbox: s.doctor.sandbox,
      tools: s.tools.map((t) => ({ name: t.name, through: t.through })),
      editorSandboxed: editorSandboxed(s.tools),
      keys: s.keys.map((k) => ({ file: k.file, line: k.line, name: k.name, kind: k.kind })),
      keysError: s.keysError,
      blocked: s.blocked,
      labels: this.readyNodes(s).map((n) => (n.t === "info" || n.t === "group" ? n.label : "")),
    };
  }

  private async roots(): Promise<string[]> {
    const projects = await this.ctx.projects();
    if (projects.length) return projects.map((p) => p.root);
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  private async load(): Promise<void> {
    const km = tool("keymoat");
    const roots = await this.roots();
    const cwd = roots[0] ?? os.homedir();
    const probe = await exec(km, ["version"], { cwd, timeoutMs: 15_000 });
    if (probe.notFound || (probe.code === null && !probe.cancelled)) {
      this.state = { kind: "missing" };
      return;
    }

    let doctorRun = await exec(km, ["doctor", "--json"], { cwd, timeoutMs: 60_000 });
    let doctor: Doctor;
    if (doctorRun.stdout.trimStart().startsWith("{")) {
      doctor = parseDoctorJson(doctorRun.stdout);
    } else {
      // A keymoat from before `doctor --json` either ignores the flag or refuses it.
      if (doctorRun.code === 2) doctorRun = await exec(km, ["doctor"], { cwd, timeoutMs: 60_000 });
      doctor = parseDoctorText(doctorRun.stdout, cwd);
      if (!doctor.tools.length && !doctor.sandbox.detail) {
        throw new Error(`could not read \`keymoat doctor\` (exit code ${doctorRun.code}): ${doctorRun.stderr.trim().slice(0, 300)}`);
      }
    }

    const scans = await Promise.all(roots.map((r) => exec(km, ["scan", "--json", r], { cwd: r, timeoutMs: 60_000 })));
    const scanned: PlainKey[][] = [];
    let keysError: string | undefined;
    for (const [i, r] of scans.entries()) {
      try {
        scanned.push(parseScan(r.stdout, r.code));
      } catch (e) {
        keysError = `Could not scan ${path.basename(roots[i])}: ${e instanceof Error ? e.message : e}`;
        this.ctx.log.warn(`keymoat scan ${roots[i]}: exit ${r.code} ${r.stderr.trim()}`);
      }
    }

    const log = await exec(km, ["log", "--json", "-n", "200"], { cwd, timeoutMs: 15_000 });
    let allowed: (host: string, project: string) => boolean = () => false;
    try {
      const home = process.env.KEYMOAT_HOME || path.join(os.homedir(), ".keymoat");
      allowed = allowedFromConfig(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    } catch {
      // no settings file yet: nothing allowed beyond keymoat's defaults
    }
    const blocked = log.code === 0 ? blockedHosts(parseLog(log.stdout), roots, allowed) : [];

    this.state = {
      kind: "ready",
      doctor,
      tools: withConfiguredLinks(doctor),
      keys: mergeKeys(doctor.plainKeys, ...scanned),
      keysError,
      blocked,
    };
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.t) {
      case "info": {
        const item = new vscode.TreeItem(n.label);
        item.description = n.description;
        item.tooltip = n.tooltip ? new vscode.MarkdownString(n.tooltip) : undefined;
        item.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
        item.command = n.command;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(n.label, n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = n.description;
        item.tooltip = n.tooltip ? new vscode.MarkdownString(n.tooltip) : undefined;
        item.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
        return item;
      }
      case "key": {
        const k = n.key;
        const where = vscode.workspace.asRelativePath(k.file);
        const item = new vscode.TreeItem(k.name ?? path.basename(k.file));
        item.description = k.line ? `${where}:${k.line}` : where;
        item.tooltip = new vscode.MarkdownString(
          `**${k.kind}** in plain text in \`${k.file}\`${k.line ? ` line ${k.line}` : ""}.\n\nAny program you run can read it, including a dependency's install script and an editor extension.\n\nFix: \`${k.fix}\``,
        );
        item.iconPath = new vscode.ThemeIcon("key", new vscode.ThemeColor("problemsWarningIcon.foreground"));
        item.contextValue = canMove(k) ? "keymoatKey.movable" : "keymoatKey";
        // A key file without a line (a Solana keypair) is all secret, so it is not opened in the editor.
        if (k.line) item.command = { command: "forgeDefender.keymoat.openKey", title: "Open", arguments: [k] };
        return item;
      }
      case "host": {
        const h = n.host;
        const item = new vscode.TreeItem(h.host);
        const when = new Date(h.last);
        const at = isNaN(when.getTime()) ? h.last : when.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
        item.description = `${h.tool ?? "a tool"}, ${h.count === 1 ? "once" : `${h.count} times`}, last ${at}`;
        item.tooltip = new vscode.MarkdownString(
          `keymoat blocked a connection to \`${h.host}\` from ${h.tool ?? "a sandboxed tool"} in \`${h.project}\`.\n\nAllow it only if you know why the project needs it (your RPC provider, a private registry). An unknown host is worth tracking down: that is what keymoat is for.`,
        );
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        item.contextValue = "keymoatHost";
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.t === "group" ? n.children : [];
    const s = this.state;
    switch (s.kind) {
      case "loading":
        return [{ t: "info", label: "Checking keymoat…", icon: "loading~spin" }];
      case "missing":
        return [
          {
            t: "info",
            label: "keymoat is not installed",
            description: "keeps wallet keys away from the code you build and test",
            tooltip:
              "keymoat runs forge, anchor, cargo, npm and other tools in a sandbox: they cannot read your wallet keys, and only reach the hosts you allow. Signing commands ask you first.\n\nClick to read about it and how to install it.",
            icon: "shield",
            command: { command: "forgeDefender.keymoat.openDocs", title: "About keymoat" },
          },
        ];
      case "error":
        return [{ t: "info", label: "Could not check keymoat", description: s.message, tooltip: s.message, icon: "error", color: "problemsErrorIcon.foreground" }];
      case "ready":
        return this.readyNodes(s);
    }
  }

  private readyNodes(s: Extract<State, { kind: "ready" }>): Node[] {
    const out: Node[] = [];
    const d = s.doctor;
    out.push(
      d.sandbox.ok
        ? { t: "info", label: "Sandbox works", description: d.sandbox.detail, tooltip: d.sandbox.detail, icon: "pass", color: "testing.iconPassed" }
        : {
            t: "info",
            label: "Sandbox does not work",
            description: d.sandbox.detail,
            tooltip: `${d.sandbox.detail}\n\nRun \`keymoat doctor\` in a terminal for details.`,
            icon: "error",
            color: "problemsErrorIcon.foreground",
          },
    );

    const relevant = relevantTools(s.tools);
    const direct = relevant.filter((t) => !t.through);
    const toolNodes: Node[] = relevant.map((t) => ({
      t: "info",
      label: t.name,
      description: t.through ? "through keymoat" : `runs directly: ${t.found}`,
      icon: t.through ? "pass" : "warning",
      color: t.through ? "testing.iconPassed" : "problemsWarningIcon.foreground",
    }));
    if (direct.length) {
      const canLink = Boolean(d.shimDir && shimmable.some((n) => fs.existsSync(path.join(d.shimDir!, n))));
      toolNodes.unshift({
        t: "info",
        label: "How to fix",
        description: canLink ? "click to run ForgeDefender's tools through keymoat" : "start VS Code from a terminal",
        tooltip:
          "VS Code was started without keymoat first on its PATH (on macOS, usually because it was opened from the Dock), so the tests and builds it runs are not sandboxed, even if your terminals are.\n\n" +
          "- Quit VS Code and start it from a terminal with `code .`, so it gets your shell's PATH.\n" +
          (canLink
            ? "- Or click here: ForgeDefender then calls forge, cast, anchor and solana through keymoat's links. Other extensions and tasks still use VS Code's PATH.\n"
            : "- Then run `keymoat install` if a tool is still listed as running directly.\n"),
        icon: "lightbulb",
        command: canLink ? { command: "forgeDefender.keymoat.useLinks", title: "Use keymoat's links" } : undefined,
      });
    }
    out.push({
      t: "group",
      id: "editor",
      label: relevant.length === 0 ? "No tools found" : direct.length ? "Editor runs are not sandboxed" : "Editor runs are sandboxed",
      description: relevant.length ? (direct.length ? `${direct.map((t) => t.name).join(", ")} run directly` : "tools VS Code starts go through keymoat") : undefined,
      tooltip: "Whether the tools VS Code itself starts (tests and builds from the editor, this extension) go through keymoat. Your terminals are a separate matter.",
      icon: direct.length ? "unlock" : "lock",
      color: direct.length ? "problemsWarningIcon.foreground" : "testing.iconPassed",
      children: toolNodes,
    });

    const keyNodes: Node[] = s.keys.map((key) => ({ t: "key", key }));
    if (s.keysError) keyNodes.push({ t: "info", label: "Scan failed", description: s.keysError, tooltip: s.keysError, icon: "error" });
    out.push({
      t: "group",
      id: "keys",
      label: s.keys.length ? `Keys in plain text: ${s.keys.length}` : "No keys in plain text",
      description: s.keys.length ? "move them into encrypted storage" : "in this project or the Solana settings",
      icon: s.keys.length ? "key" : "pass",
      color: s.keys.length ? "problemsWarningIcon.foreground" : "testing.iconPassed",
      children: keyNodes,
    });

    out.push({
      t: "group",
      id: "hosts",
      label: s.blocked.length ? `Blocked hosts: ${s.blocked.length}` : "No blocked hosts",
      description: s.blocked.length ? "for this project, in keymoat's recent log" : undefined,
      icon: "globe",
      children: s.blocked.map((host) => ({ t: "host", host })),
    });

    if (d.legacy) {
      out.push({
        t: "info",
        label: "Update keymoat",
        description: "this version shows less detail",
        tooltip: "This keymoat has no `doctor --json`, so the view reads its text output. A newer keymoat gives line numbers and more.",
        icon: "arrow-up",
        command: { command: "vscode.open", title: "Install keymoat", arguments: [vscode.Uri.parse(links.keymoatInstall)] },
      });
    }
    return out;
  }

  async allow(n: Node | BlockedHost): Promise<void> {
    const h = "t" in n ? (n.t === "host" ? n.host : undefined) : n;
    if (!h) return;
    const pick = await vscode.window.showWarningMessage(
      `Let sandboxed commands in ${path.basename(h.project)} connect to ${h.host}?`,
      { modal: true, detail: `Only allow ${h.host} if you know why this project needs it, such as your RPC provider or a private registry.` },
      "Allow",
    );
    if (pick !== "Allow") return;
    const r = await exec(tool("keymoat"), ["allow", h.host], { cwd: h.project, timeoutMs: 15_000 });
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(`keymoat could not allow ${h.host}: ${(r.stderr || r.stdout).trim()}`);
      return;
    }
    this.ctx.log.info(`keymoat: allowed ${h.host} for ${h.project}`);
    this.refresh();
  }

  async useLinks(): Promise<void> {
    if (this.state.kind !== "ready" || !this.state.doctor.shimDir) return;
    const dir = this.state.doctor.shimDir;
    const cfg = vscode.workspace.getConfiguration("forgeDefender.paths");
    const done: string[] = [];
    for (const name of shimmable) {
      const link = path.join(dir, name);
      if (!fs.existsSync(link)) continue;
      await cfg.update(name, link, vscode.ConfigurationTarget.Global);
      done.push(name);
    }
    void vscode.window.showInformationMessage(
      `ForgeDefender now runs ${done.join(", ")} through keymoat. Other extensions and tasks still use VS Code's PATH: start VS Code from a terminal with "code ." to cover them too.`,
    );
  }
}

function relevantTools(tools: DoctorTool[]): DoctorTool[] {
  return tools.filter((t) => editorTools.includes(t.name) && (t.found || t.through));
}

function editorSandboxed(tools: DoctorTool[]): boolean {
  const relevant = relevantTools(tools);
  return relevant.length > 0 && relevant.every((t) => t.through);
}

/** A tool path set in ForgeDefender's settings to one of keymoat's links counts as going through keymoat. */
function withConfiguredLinks(d: Doctor): DoctorTool[] {
  const dir = d.shimDir;
  if (!dir) return d.tools;
  return d.tools.map((t) => {
    if (t.through || !(shimmable as readonly string[]).includes(t.name)) return t;
    const configured = tool(t.name as (typeof shimmable)[number]);
    return path.dirname(configured) === dir ? { ...t, through: true, found: configured } : t;
  });
}

function canMove(k: PlainKey): boolean {
  return k.fix.startsWith("keymoat keys move");
}

async function openKey(k: PlainKey): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(k.file));
  const line = Math.max(0, (k.line ?? 1) - 1);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
}

function moveKey(ctx: Ctx, n: Node | PlainKey): void {
  const k = "t" in n ? (n.t === "key" ? n.key : undefined) : n;
  if (!k || !canMove(k)) return;
  // `keys move` asks for a name and a password, so it needs a terminal.
  runInTerminal({ name: "keymoat", cwd: path.dirname(k.file), args: [tool("keymoat"), "keys", "move", k.file] });
  ctx.log.info(`keymoat: moving the key in ${k.file} into encrypted storage`);
}
