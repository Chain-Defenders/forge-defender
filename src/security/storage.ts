import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec, stripAnsi } from "../core/exec";
import { projectOf, type FoundryProject } from "../core/projects";
import { parseSolidity, type SolContract } from "../core/solidity";
import { setting, tool } from "../core/tools";
import { layoutHtml } from "./html";
import { baselinePath, compareLayouts, looksUpgradeable, parseLayout, stripLayout, type Baseline, type LayoutIssue, type StorageLayout } from "./layout";
import { lastLines, relPath, showHtml } from "./ui";

// Storage layouts of upgradeable contracts: show one, save it as a baseline (committed with the code), and check the
// current layouts against the baselines, with any break shown on the contract's line.

const SOURCE = "ForgeDefender storage";

export async function inspectLayout(root: string, source: string, name: string, signal?: AbortSignal): Promise<StorageLayout> {
  const r = await exec(tool("forge"), ["inspect", `${source}:${name}`, "storageLayout", "--json"], { cwd: root, timeoutMs: 600_000, signal });
  if (r.notFound) throw new Error("forge is not installed or not on the PATH");
  if (r.code !== 0) throw new Error(`forge inspect failed: ${lastLines(stripAnsi(r.stderr || r.stdout))}`);
  return parseLayout(r.stdout);
}

function baselineFiles(root: string): string[] {
  const dir = path.join(root, ".forgedefender", "storage");
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}

function readBaseline(file: string): Baseline | undefined {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof b.contract === "string" && b.layout?.storage ? b : undefined;
  } catch {
    return undefined;
  }
}

/** The contract under the cursor, or the only one in the file, or one the user picks. */
async function contractAt(doc: vscode.TextDocument, at?: vscode.Position, name?: string): Promise<SolContract | undefined> {
  const contracts = parseSolidity(doc.getText()).contracts.filter((c) => c.kind === "contract");
  if (name) return contracts.find((c) => c.name === name);
  if (at) {
    const off = doc.offsetAt(at);
    const hit = contracts.find((c) => off >= c.offset && off <= c.bodyEnd);
    if (hit) return hit;
  }
  if (contracts.length <= 1) return contracts[0];
  const pick = await vscode.window.showQuickPick(
    contracts.map((c) => ({ label: c.name, c })),
    { placeHolder: "Which contract?" },
  );
  return pick?.c;
}

interface Target {
  project: FoundryProject;
  source: string;
  contract: SolContract;
}

export function register(ctx: Ctx): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("forgeDefender.storage");
  const lensesChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(diagnostics, lensesChanged);
  const perProject = new Map<string, vscode.Uri[]>();

  async function target(uri?: vscode.Uri, name?: string): Promise<Target | undefined> {
    const editor = vscode.window.activeTextEditor;
    const fileUri = uri ?? editor?.document.uri;
    if (!fileUri || !fileUri.fsPath.endsWith(".sol")) {
      void vscode.window.showInformationMessage("Open a Solidity file and put the cursor in a contract.");
      return undefined;
    }
    const project = projectOf(await ctx.foundryProjects(), fileUri.fsPath);
    if (!project) {
      void vscode.window.showInformationMessage("This file is not in a Foundry project.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const at = editor && editor.document.uri.fsPath === fileUri.fsPath ? editor.selection.active : undefined;
    const contract = await contractAt(doc, at, name);
    if (!contract) {
      void vscode.window.showInformationMessage(name ? `No contract ${name} in this file.` : "No contract in this file.");
      return undefined;
    }
    return { project, source: relPath(project.root, fileUri.fsPath), contract };
  }

  const withProgress = <T>(title: string, run: (signal: AbortSignal) => Promise<T>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (_p, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      return run(ac.signal);
    });

  async function show(uri?: vscode.Uri, name?: string): Promise<StorageLayout | undefined> {
    const t = await target(uri, name);
    if (!t) return undefined;
    try {
      const layout = await withProgress(`Reading the storage layout of ${t.contract.name}`, (signal) => inspectLayout(t.project.root, t.source, t.contract.name, signal));
      const saved = readBaseline(path.join(t.project.root, baselinePath(t.source, t.contract.name)))?.saved;
      showHtml(`layout:${t.source}:${t.contract.name}`, `Storage: ${t.contract.name}`, (csp) => layoutHtml(`${t.source}:${t.contract.name}`, layout, saved, csp));
      return layout;
    } catch (e) {
      void vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e));
      return undefined;
    }
  }

  async function save(uri?: vscode.Uri, name?: string): Promise<string | undefined> {
    const t = await target(uri, name);
    if (!t) return undefined;
    try {
      const layout = await withProgress(`Saving the storage baseline of ${t.contract.name}`, (signal) => inspectLayout(t.project.root, t.source, t.contract.name, signal));
      const rel = baselinePath(t.source, t.contract.name);
      const file = path.join(t.project.root, rel);
      const baseline: Baseline = { contract: `${t.source}:${t.contract.name}`, saved: new Date().toISOString().slice(0, 10), layout: stripLayout(layout) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n");
      ctx.log.info(`storage baseline saved: ${rel}`);
      lensesChanged.fire();
      void vscode.window.showInformationMessage(`Saved ${rel}. Commit it with the code it describes.`);
      await check(t.project, true);
      return file;
    } catch (e) {
      void vscode.window.showErrorMessage(String(e instanceof Error ? e.message : e));
      return undefined;
    }
  }

  /** Checks every baseline in the project and replaces its diagnostics. Returns the issues per contract. */
  async function check(project: FoundryProject, quiet: boolean, signal?: AbortSignal): Promise<Record<string, LayoutIssue[]>> {
    const results: Record<string, LayoutIssue[]> = {};
    const byFile = new Map<string, vscode.Diagnostic[]>();
    const add = (file: string, d: vscode.Diagnostic) => byFile.set(file, [...(byFile.get(file) ?? []), d]);
    for (const file of baselineFiles(project.root)) {
      if (signal?.aborted) break;
      const b = readBaseline(file);
      if (!b) continue;
      const cut = b.contract.lastIndexOf(":");
      const source = b.contract.slice(0, cut);
      const name = b.contract.slice(cut + 1);
      const sourceFile = path.join(project.root, source);
      let text: string | undefined;
      try {
        text = fs.readFileSync(sourceFile, "utf8");
      } catch {
        text = undefined;
      }
      const c = text === undefined ? undefined : parseSolidity(text).contracts.find((x) => x.name === name);
      if (!c) {
        const d = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `Storage baseline for ${b.contract}, but ${text === undefined ? "the file" : "the contract"} is gone. Delete the baseline if that is intended.`,
          vscode.DiagnosticSeverity.Warning,
        );
        d.source = SOURCE;
        add(file, d);
        continue;
      }
      let issues: LayoutIssue[];
      try {
        issues = compareLayouts(b.layout, await inspectLayout(project.root, source, name, signal));
      } catch (e) {
        ctx.log.warn(`storage check of ${b.contract}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      results[b.contract] = issues;
      const range = new vscode.Range(c.line, 0, c.line, 1000);
      for (const i of issues) {
        const d = new vscode.Diagnostic(
          range,
          `${i.message} (storage baseline of ${b.saved})`,
          i.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        d.source = SOURCE;
        d.code = i.kind;
        add(sourceFile, d);
      }
    }
    for (const uri of perProject.get(project.root) ?? []) diagnostics.delete(uri);
    const uris = [...byFile.keys()].map((f) => vscode.Uri.file(f));
    for (const uri of uris) diagnostics.set(uri, byFile.get(uri.fsPath));
    perProject.set(project.root, uris);
    if (!quiet) {
      const n = Object.keys(results).length;
      const breaks = Object.values(results).reduce((s, l) => s + l.filter((i) => i.severity === "error").length, 0);
      void vscode.window.showInformationMessage(
        n === 0
          ? "No storage baselines in this project yet. Save one from an upgradeable contract."
          : breaks === 0
            ? `Storage layouts match ${n} ${n === 1 ? "baseline" : "baselines"}.`
            : `${breaks} storage layout ${breaks === 1 ? "break" : "breaks"} against the baselines. See Problems.`,
      );
    }
    return results;
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("forgeDefender.security.showStorageLayout", (uri?: unknown, name?: string) =>
      show(uri instanceof vscode.Uri ? uri : undefined, typeof name === "string" ? name : undefined),
    ),
    vscode.commands.registerCommand("forgeDefender.security.saveStorageBaseline", (uri?: unknown, name?: string) =>
      save(uri instanceof vscode.Uri ? uri : undefined, typeof name === "string" ? name : undefined),
    ),
    vscode.commands.registerCommand("forgeDefender.security.checkStorageLayouts", async (root?: unknown, quiet?: boolean) => {
      const project = typeof root === "string" ? (await ctx.foundryProjects()).find((p) => p.root === root) : await ctx.pickFoundryProject();
      if (!project) return undefined;
      return withProgress("Checking storage layouts", (signal) => check(project, quiet === true, signal));
    }),
    ctx.onDidRunFoundryTests((e) => {
      if (!setting("security.storage.checkAfterTests", true) || !baselineFiles(e.project.root).length) return;
      void check(e.project, true).catch((err) => ctx.log.warn(`storage check: ${err}`));
    }),
  );

  // A lens on contracts that look upgradeable: save a baseline, or check against the one saved. Nothing pops up.
  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      // By pattern, not language: the Solidity language id only exists when a Solidity extension is installed.
      { scheme: "file", pattern: "**/*.sol" },
      {
        onDidChangeCodeLenses: lensesChanged.event,
        async provideCodeLenses(doc) {
          if (!setting("security.storage.codeLens", true)) return [];
          const project = projectOf(await ctx.foundryProjects(), doc.uri.fsPath);
          if (!project) return [];
          const source = relPath(project.root, doc.uri.fsPath);
          if (!source.startsWith(project.config.src.replace(/^\.\//, "").replace(/\/$/, "") + "/")) return [];
          const text = doc.getText();
          const lenses: vscode.CodeLens[] = [];
          for (const c of parseSolidity(text).contracts) {
            if (c.kind !== "contract" || c.abstract) continue;
            if (!looksUpgradeable(c.bases, c.functions.map((f) => f.name), text.slice(c.bodyStart, c.bodyEnd))) continue;
            const range = new vscode.Range(c.line, 0, c.line, 0);
            const has = fs.existsSync(path.join(project.root, baselinePath(source, c.name)));
            lenses.push(
              has
                ? new vscode.CodeLens(range, { title: "Check storage against baseline", command: "forgeDefender.security.checkStorageLayouts", arguments: [project.root] })
                : new vscode.CodeLens(range, { title: "Save storage baseline", command: "forgeDefender.security.saveStorageBaseline", arguments: [doc.uri, c.name] }),
              new vscode.CodeLens(range, { title: "Storage layout", command: "forgeDefender.security.showStorageLayout", arguments: [doc.uri, c.name] }),
            );
          }
          return lenses;
        },
      },
    ),
  );
}
