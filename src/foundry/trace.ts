import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec } from "../core/exec";
import type { FoundryProject } from "../core/projects";
import { walk } from "../core/projects";
import { parseSolidity } from "../core/solidity";
import { listArtifacts } from "../core/artifacts";
import { setting, tool } from "../core/tools";
import type { TestData } from "./testing";
import { parseTraces, TestTrace, TraceNode } from "./traceParse";

// A test's call trace as a tree that folds, with each call linked to the function it ran. The trace comes from
// running the one test again with -vvvv, so it is current and fully decoded.

class TraceItem extends vscode.TreeItem {
  constructor(readonly node: TraceNode, location: vscode.Location | undefined) {
    super(label(node), node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.description = node.gas !== undefined ? `${node.gas.toLocaleString("en-US")} gas` : undefined;
    this.tooltip = node.text;
    this.iconPath = icon(node);
    if (location) {
      this.command = { command: "vscode.open", title: "Open", arguments: [location.uri, { selection: location.range }] };
    }
  }
}

function label(n: TraceNode): string {
  const text = n.text.replace(/^\[\d+\]\s*/, "");
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

function icon(n: TraceNode): vscode.ThemeIcon {
  const red = new vscode.ThemeColor("testing.iconFailed");
  switch (n.kind) {
    case "call":
      return n.reverted ? new vscode.ThemeIcon("error", red) : new vscode.ThemeIcon(n.target === "VM" || n.target === "console" ? "tools" : "call-outgoing");
    case "create":
      return new vscode.ThemeIcon(n.reverted ? "error" : "add", n.reverted ? red : undefined);
    case "return":
      return n.status === "Revert" ? new vscode.ThemeIcon("arrow-left", red) : new vscode.ThemeIcon("arrow-left");
    case "emit":
      return new vscode.ThemeIcon("broadcast");
    default:
      return new vscode.ThemeIcon("circle-small");
  }
}

/** Where each contract and its functions are written, from the project's own sources and its build. */
class SourceIndex {
  private readonly contracts = new Map<string, { file: string; line: number; functions: Map<string, number> }>();

  constructor(project: FoundryProject) {
    const add = (file: string) => {
      let src: string;
      try {
        src = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      for (const c of parseSolidity(src).contracts) {
        if (this.contracts.has(c.name)) continue;
        this.contracts.set(c.name, { file, line: c.line, functions: new Map(c.functions.map((f) => [f.name, f.line])) });
      }
    };
    for (const dir of [project.config.src, project.config.test, project.config.script]) {
      for (const f of walk(path.join(project.root, dir), [".sol"])) add(f);
    }
    // Contracts from dependencies are found through the build, which records each one's source path.
    for (const a of listArtifacts(project.root, project.config.out)) {
      if (!this.contracts.has(a.name) && a.source) add(path.resolve(project.root, a.source));
    }
  }

  locate(n: TraceNode): vscode.Location | undefined {
    if (!n.target) return undefined;
    const c = this.contracts.get(n.target);
    if (!c) return undefined;
    const line = (n.fn ? c.functions.get(n.fn) : undefined) ?? c.line;
    return new vscode.Location(vscode.Uri.file(c.file), new vscode.Range(line, 0, line, 0));
  }
}

class TraceProvider implements vscode.TreeDataProvider<TraceNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  trace?: TestTrace;
  title?: string;
  private index?: SourceIndex;

  show(trace: TestTrace, title: string, index: SourceIndex) {
    this.trace = trace;
    this.title = title;
    this.index = index;
    this.changed.fire();
  }

  getTreeItem(n: TraceNode): vscode.TreeItem {
    return new TraceItem(n, this.index?.locate(n));
  }

  getChildren(n?: TraceNode): TraceNode[] {
    if (n) return n.children;
    if (!this.trace) return [];
    // setUp first, collapsed by the order forge prints it; the test's own frame is the last root.
    return this.trace.roots;
  }

  dispose() {
    this.changed.dispose();
  }
}

export async function traceTest(ctx: Ctx, data: TestData, signal?: AbortSignal): Promise<{ trace?: TestTrace; output: string; error?: string }> {
  const args = [
    "test",
    "-vvvv",
    "--match-path",
    data.file,
    "--match-contract",
    `^${data.contract}$`,
    "--match-test",
    `^${data.test.name}$`,
    ...setting<string[]>("tests.extraArgs", []),
  ];
  ctx.log.info(`forge ${args.join(" ")}`);
  const r = await exec(tool("forge"), args, { cwd: data.project.root, signal, env: { FORCE_COLOR: "0", NO_COLOR: "1" } });
  if (r.notFound) return { output: "", error: "forge was not found. Install Foundry, or set forgeDefender.paths.forge." };
  const output = r.stdout + "\n" + r.stderr;
  const trace = parseTraces(r.stdout);
  if (!trace.roots.length) return { output, error: "forge printed no trace for this test. The output is in the ForgeDefender log." };
  return { trace, output };
}

export function register(ctx: Ctx): void {
  const provider = new TraceProvider();
  const view = vscode.window.createTreeView("forgeDefender.trace", { treeDataProvider: provider, showCollapseAll: true });
  ctx.subscriptions.push(
    provider,
    view,
    vscode.commands.registerCommand("forgeDefender.trace.show", async (arg?: vscode.TestItem | { test: vscode.TestItem }) => {
      const item = arg && "test" in arg ? arg.test : arg;
      const d = item && ctx.foundryTests?.dataOf(item);
      if (!d || d.kind !== "test") {
        void vscode.window.showInformationMessage("Pick a single Foundry test to trace.");
        return;
      }
      await vscode.window.withProgress(
        { location: { viewId: "forgeDefender.trace" }, title: `Tracing ${d.test.name}`, cancellable: true },
        async (_p, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          const r = await traceTest(ctx, d, abort.signal);
          if (abort.signal.aborted) return;
          if (!r.trace) {
            ctx.log.info(r.output);
            void vscode.window.showWarningMessage(r.error ?? "No trace.");
            return;
          }
          provider.show(r.trace, `${d.contract}.${d.test.name}`, new SourceIndex(d.project));
          view.title = `Trace: ${d.test.name}`;
          view.message = r.trace.logs.length ? `Logs: ${r.trace.logs.join(" · ")}` : undefined;
          await vscode.commands.executeCommand("setContext", "forgeDefender.trace.has", true);
          await vscode.commands.executeCommand("forgeDefender.trace.focus");
        },
      );
    }),
  );
}
