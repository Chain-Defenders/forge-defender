import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { setting } from "../core/tools";
import type { AnchorProject } from "../core/projects";
import { readAnchorConfig } from "../anchor/config";
import { anchorRuns } from "../anchor/events";
import { logFileProgram, parseProgramLogs, summarise, type CuSummary } from "./computeUnits";
import { parseIdl, type IdlNode } from "./idl";
import { findProgramAddressFor, splitSeeds, type Pda } from "./pda";

// The Solana view: compute units from the last test run, program sizes and IDLs, per Anchor project. Everything
// is read from files the Anchor CLI leaves behind, so nothing here runs a tool.

interface Node {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  color?: string;
  contextValue?: string;
  file?: string;
  children?: Node[];
}

export interface ProjectState {
  root: string;
  name: string;
  computeUnits: CuSummary[];
  programNames: Map<string, string>;
  sizes: { name: string; bytes: number }[];
  idls: { file: string; name: string; address?: string; nodes: IdlNode[]; error?: string }[];
}

export function readProjectState(project: AnchorProject): ProjectState {
  const logDir = path.join(project.root, ".anchor", "program-logs");
  const programNames = new Map<string, string>();
  for (const [name, address] of readAnchorConfig(project.root).programs) programNames.set(address, name);
  const logs = list(logDir)
    .map((f) => ({ f, p: logFileProgram(f) }))
    .filter((x) => x.p);
  for (const { p } of logs) if (p!.name) programNames.set(p!.address, p!.name);
  const samples = logs.map(({ f }) => parseProgramLogs(read(path.join(logDir, f))));
  const computeUnits = summarise(samples, new Set(logs.map((x) => x.p!.address)));

  const deployDir = path.join(project.root, "target", "deploy");
  const sizes = list(deployDir)
    .filter((f) => f.endsWith(".so"))
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(deployDir, f)).size }));

  const idlDir = path.join(project.root, "target", "idl");
  const idls = list(idlDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = path.join(idlDir, f);
      try {
        const idl = parseIdl(JSON.parse(read(file)));
        if (idl.address) programNames.set(idl.address, idl.name);
        return { file, ...idl };
      } catch (e) {
        return { file, name: f, nodes: [], error: `Could not read: ${e instanceof Error ? e.message : e}` };
      }
    });
  return { root: project.root, name: project.name, computeUnits, programNames, sizes, idls };
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const num = (n: number) => n.toLocaleString("en-US");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function stateNodes(s: ProjectState, threshold: number): Node[] {
  const short = (a: string) => s.programNames.get(a) ?? `${a.slice(0, 4)}…${a.slice(-4)}`;
  const multiplePrograms = new Set(s.computeUnits.map((c) => c.program)).size > 1;
  const over = s.computeUnits.filter((c) => c.max > threshold).length;
  const cu: Node = {
    label: "Compute units",
    description: s.computeUnits.length ? (over ? `${over} over ${num(threshold)}` : "last test run") : undefined,
    icon: "dashboard",
    children: s.computeUnits.length
      ? s.computeUnits.map((c) => ({
          label: multiplePrograms ? `${short(c.program)}: ${c.instruction}` : c.instruction,
          description: `${num(c.max)} CU` + (c.count > 1 ? `  (avg ${num(c.avg)}, min ${num(c.min)}, ${c.count} calls)` : ""),
          tooltip:
            `${short(c.program)} ${c.instruction}\nMax ${num(c.max)}, average ${num(c.avg)}, min ${num(c.min)} compute units over ${c.count} call(s)` +
            `\nBudget: ${num(c.budget)}` +
            (c.failed ? `\n${c.failed} call(s) in failed transactions` : "") +
            (c.max > threshold ? `\nOver the ${num(threshold)} warning threshold (forgeDefender.solana.computeUnitWarning)` : ""),
          icon: c.max > threshold ? "warning" : "symbol-event",
          color: c.max > threshold ? "list.warningForeground" : undefined,
        }))
      : [{ label: "Run the Anchor tests to see compute units", icon: "info" }],
  };
  const sizes: Node = {
    label: "Program sizes",
    icon: "file-binary",
    children: s.sizes.length
      ? s.sizes.map((p) => ({ label: p.name, description: formatBytes(p.bytes), tooltip: `${num(p.bytes)} bytes`, icon: "file-binary" }))
      : [{ label: "Build with `anchor build` to see sizes", icon: "info" }],
  };
  const toNode = (n: IdlNode): Node => ({ ...n, children: n.children?.map(toNode) });
  const idl: Node = {
    label: "IDL",
    icon: "symbol-interface",
    children: s.idls.length
      ? s.idls.map((i) => ({
          label: i.name,
          description: i.error ?? i.address,
          tooltip: i.address ? `${i.name}\n${i.address}` : i.name,
          icon: i.error ? "error" : "symbol-module",
          contextValue: "idl",
          file: i.file,
          children: i.nodes.map(toNode),
        }))
      : [{ label: "Build with `anchor build` to see the IDL", icon: "info" }],
  };
  return [cu, sizes, idl];
}

class SolanaTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  states: ProjectState[] = [];

  constructor(private readonly ctx: Ctx) {}

  async refresh() {
    const projects = await this.ctx.anchorProjects();
    this.states = projects.map(readProjectState);
    void vscode.commands.executeCommand("setContext", "forgeDefender.anchorProjects", projects.length > 0);
    this.changed.fire();
  }

  roots(): Node[] {
    const threshold = setting<number>("solana.computeUnitWarning", 100_000);
    if (this.states.length === 1) return stateNodes(this.states[0], threshold);
    return this.states.map((s) => ({ label: s.name, icon: "folder", children: stateNodes(s, threshold) }));
  }

  getChildren(node?: Node): Node[] {
    return node ? node.children ?? [] : this.roots();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(
      n.label,
      n.children?.length ? (n.icon === "folder" || ["Compute units", "Program sizes", "IDL"].includes(n.label) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None,
    );
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.contextValue = n.contextValue;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
    if (n.file) item.resourceUri = vscode.Uri.file(n.file);
    return item;
  }

  dispose() {
    this.changed.dispose();
  }
}

export function register(ctx: Ctx): void {
  const tree = new SolanaTree(ctx);
  const view = vscode.window.createTreeView("forgeDefender.solana", { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(tree, view);

  let timer: NodeJS.Timeout | undefined;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tree.refresh(), 400);
  };
  const ready = tree.refresh();
  for (const glob of ["**/.anchor/program-logs/*.log", "**/target/deploy/*.so", "**/target/idl/*.json"]) {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    w.onDidChange(soon);
    w.onDidCreate(soon);
    w.onDidDelete(soon);
    ctx.subscriptions.push(w);
  }
  ctx.subscriptions.push(
    anchorRuns.event(() => void tree.refresh()),
    ctx.onDidChangeProjects(() => void tree.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgeDefender.solana")) void tree.refresh();
    }),
    { dispose: () => timer && clearTimeout(timer) },
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("forgeDefender.solana.refresh", async () => {
      await ready;
      await tree.refresh();
    }),
    vscode.commands.registerCommand("forgeDefender.solana.openIdl", async (n?: Node) => {
      const file = n?.file ?? tree.states.flatMap((s) => s.idls)[0]?.file;
      if (file) await vscode.window.showTextDocument(vscode.Uri.file(file));
    }),
    vscode.commands.registerCommand("forgeDefender.solana.findPda", (programId?: string, seeds?: string[]) => findPda(ctx, tree, programId, seeds)),
    // Not in the palette; for the editor tests: what the view shows.
    vscode.commands.registerCommand("forgeDefender.solana.viewState", viewState),
  );
  (ctx as unknown as { api?: Map<string, unknown> }).api?.set("solanaTools", { viewState, refresh: () => tree.refresh() });

  async function viewState() {
    await ready;
    const plain = (n: Node): object => ({ label: n.label, description: n.description, icon: n.icon, children: n.children?.map(plain) });
    return tree.roots().map(plain);
  }
}

async function findPda(ctx: Ctx, tree: SolanaTree, programId?: string, seeds?: string[]): Promise<Pda | undefined> {
  // Called with arguments (from a script or test): no prompts, errors are thrown.
  if (programId !== undefined) return findProgramAddressFor(programId, seeds ?? []);

  const known = new Map<string, string>();
  for (const s of tree.states) {
    for (const [address, name] of s.programNames) known.set(address, name);
  }
  let program: string | undefined;
  if (known.size) {
    const other = { label: "Another program id…", address: "" };
    const pick = await vscode.window.showQuickPick(
      [...[...known].map(([address, name]) => ({ label: name, description: address, address })), other],
      { placeHolder: "Program that owns the address" },
    );
    if (!pick) return undefined;
    program = pick.address || undefined;
  }
  program ??= await vscode.window.showInputBox({
    prompt: "Program id",
    placeHolder: "Base58 address of the program",
    validateInput: (v) => {
      try {
        findProgramAddressFor(v.trim(), []);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  if (!program) return undefined;
  const programId_ = program.trim();
  const line = await vscode.window.showInputBox({
    prompt: "Seeds, separated by spaces: string:, pubkey:, hex:, u8:, u16:, u32:, u64: (little-endian; add be for big-endian, e.g. u64be:)",
    placeHolder: 'string:counter pubkey:<address> u64:1   (quote values with spaces: string:"two words")',
    validateInput: (v) => {
      try {
        findProgramAddressFor(programId_, splitSeeds(v));
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  if (line === undefined) return undefined;
  const seedList = splitSeeds(line);
  const pda = findProgramAddressFor(programId_, seedList);
  ctx.log.info(`PDA for program ${programId_}, seeds [${seedList.join(" ")}]: ${pda.address} (bump ${pda.bump})`);
  const pick = await vscode.window.showInformationMessage(`PDA ${pda.address} (bump ${pda.bump})`, "Copy Address");
  if (pick === "Copy Address") await vscode.env.clipboard.writeText(pda.address);
  return pda;
}
