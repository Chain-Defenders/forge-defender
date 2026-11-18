import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec, stripAnsi } from "../core/exec";
import type { FoundryProject } from "../core/projects";
import { walk } from "../core/projects";
import { parseSolidity, SolFile } from "../core/solidity";
import { setting, tool } from "../core/tools";
import { DiscoveredContract, DiscoveredTest, discoverTests } from "./discover";
import { describeGas, gasChange, parseSnapshot, SnapshotEntry } from "./gas";
import { Lcov, parseLcov } from "./lcov";
import { importsForgeStd, insertion, regressionTest } from "./regression";
import { parseTestJson, SuiteResult, TestOutcome } from "./results";
import { parseCompilerMessages, parseTextResults } from "./text";

// Foundry tests in VS Code's own Testing view. The tree comes from reading the sources; results come from
// `forge test --json`, which is authoritative: a test forge reports that the tree lacks is added.
//
// Item ids: "<root>" for a project (only when there are several), "<root>|<file>", "<root>|<file>|<Contract>",
// "<root>|<file>|<Contract>|<test>". <file> is relative to the project root, as forge prints it.

export interface TestData {
  project: FoundryProject;
  file: string;
  contract: string;
  test: DiscoveredTest;
}

type ItemData =
  | { kind: "project"; project: FoundryProject }
  | { kind: "file"; project: FoundryProject; file: string }
  | { kind: "contract"; project: FoundryProject; file: string; contract: string }
  | ({ kind: "test" } & TestData);

export interface LastOutcome {
  outcome: TestOutcome;
  data: TestData;
}

interface Group {
  args: string[];
  items: vscode.TestItem[];
}

export class FoundryTests implements vscode.Disposable {
  readonly controller: vscode.TestController;
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  /** Last result per test id, for regression tests and traces. */
  readonly last = new Map<string, LastOutcome>();
  private readonly compileErrors: vscode.DiagnosticCollection;
  private readonly gasDecoration: vscode.TextEditorDecorationType;
  /** File path → line → decoration text. */
  private readonly gasByFile = new Map<string, Map<number, { text: string; worse: boolean }>>();
  private readonly coverageDetails = new WeakMap<vscode.FileCoverage, vscode.FileCoverageDetail[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private discovering?: Promise<void>;
  private sourceTimer?: NodeJS.Timeout;
  readonly runProfile: vscode.TestRunProfile;
  readonly coverageProfile: vscode.TestRunProfile;

  constructor(private readonly ctx: Ctx) {
    this.controller = vscode.tests.createTestController("forgeDefender.foundry", "Foundry");
    this.compileErrors = vscode.languages.createDiagnosticCollection("forge");
    this.gasDecoration = vscode.window.createTextEditorDecorationType({
      after: { margin: "0 0 0 2em", color: new vscode.ThemeColor("editorCodeLens.foreground") },
    });
    this.disposables.push(this.controller, this.compileErrors, this.gasDecoration);

    this.controller.resolveHandler = async (item) => {
      if (!item) await this.discoverAll();
    };
    this.controller.refreshHandler = async () => {
      await this.discoverAll(true);
    };

    this.runProfile = this.controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, (r, t) => this.run(r, t, false), true, undefined, true);
    this.coverageProfile = this.controller.createRunProfile("Coverage", vscode.TestRunProfileKind.Coverage, (r, t) => this.run(r, t, true), true);
    this.coverageProfile.loadDetailedCoverage = async (_run, fc) => this.coverageDetails.get(fc) ?? [];
    const debug = this.controller.createRunProfile("Debug in terminal", vscode.TestRunProfileKind.Debug, (r) => this.debugInTerminal(r), true);
    this.disposables.push(this.runProfile, this.coverageProfile, debug);

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.sol");
    const changed = (uri: vscode.Uri) => this.onSourceChanged(uri);
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    this.disposables.push(
      watcher,
      ctx.onDidChangeProjects(() => void this.discoverAll(true)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintGas()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("forgeDefender.gas")) this.paintGas();
      }),
    );
  }

  // ---- discovery -------------------------------------------------------------------------------------------------

  discoverAll(force = false): Promise<void> {
    if (this.discovering && !force) return this.discovering;
    this.discovering = (async () => {
      const projects = await this.ctx.foundryProjects();
      const several = projects.length > 1;
      const roots: vscode.TestItem[] = [];
      for (const p of projects) {
        const files = this.discoverProject(p);
        if (several) {
          const item = this.controller.createTestItem(p.root, p.name, vscode.Uri.file(p.root));
          this.data.set(item, { kind: "project", project: p });
          item.children.replace(files);
          roots.push(item);
        } else roots.push(...files);
      }
      this.controller.items.replace(roots);
    })().catch((e) => this.ctx.log.error(`discovering tests: ${e}`));
    return this.discovering;
  }

  /** Test files: everything under the test folder, plus *.t.sol anywhere in the sources. */
  private testSources(p: FoundryProject): Map<string, SolFile> {
    const files = new Set([...walk(path.join(p.root, p.config.test), [".sol"]), ...walk(path.join(p.root, p.config.src), [".t.sol"])]);
    const parsed = new Map<string, SolFile>();
    for (const f of files) {
      try {
        parsed.set(path.relative(p.root, f), parseSolidity(fs.readFileSync(f, "utf8")));
      } catch {
        // unreadable: skipped
      }
    }
    return parsed;
  }

  private discoverProject(p: FoundryProject): vscode.TestItem[] {
    const found = discoverTests(this.testSources(p));
    return [...found].map(([file, contracts]) => this.fileItem(p, file, contracts));
  }

  private fileItem(p: FoundryProject, file: string, contracts: DiscoveredContract[]): vscode.TestItem {
    const uri = vscode.Uri.file(path.join(p.root, file));
    const item = this.controller.createTestItem(`${p.root}|${file}`, path.basename(file), uri);
    item.description = path.dirname(file) === "." ? undefined : path.dirname(file);
    this.data.set(item, { kind: "file", project: p, file });
    item.children.replace(contracts.map((c) => this.contractItem(p, file, c)));
    return item;
  }

  private contractItem(p: FoundryProject, file: string, c: DiscoveredContract): vscode.TestItem {
    const uri = vscode.Uri.file(path.join(p.root, file));
    const item = this.controller.createTestItem(`${p.root}|${file}|${c.name}`, c.name, uri);
    item.range = new vscode.Range(c.line, 0, c.line, 0);
    this.data.set(item, { kind: "contract", project: p, file, contract: c.name });
    item.children.replace(c.tests.map((t) => this.testItem(p, file, c.name, t)));
    return item;
  }

  private testItem(p: FoundryProject, file: string, contract: string, t: DiscoveredTest): vscode.TestItem {
    const id = `${p.root}|${file}|${contract}|${t.name}`;
    const item = this.controller.createTestItem(id, t.name, vscode.Uri.file(path.join(p.root, t.file)));
    item.range = new vscode.Range(t.line, 0, t.line, 0);
    item.tags = [new vscode.TestTag(t.kind)];
    const data: TestData = { project: p, file, contract, test: t };
    this.data.set(item, { kind: "test", ...data });
    const before = this.last.get(id);
    item.description = this.describe(data, before?.outcome);
    return item;
  }

  private describe(data: TestData, outcome?: TestOutcome, snapshot?: Map<string, SnapshotEntry>): string | undefined {
    const parts: string[] = [];
    if (outcome?.gas !== undefined) parts.push(this.gasText(data.project, data.contract, outcome, snapshot));
    if (data.test.inheritedFrom) parts.push(`from ${data.test.inheritedFrom}`);
    return parts.join(" · ") || undefined;
  }

  private onSourceChanged(uri: vscode.Uri) {
    if (/[\\/](lib|node_modules|dependencies|out|cache)[\\/]/.test(uri.fsPath)) return;
    clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => void this.rediscover(uri), 300);
  }

  /** Rebuilds the tree of the project owning the file. Cheap: it only reads test sources. */
  async rediscover(uri: vscode.Uri) {
    const projects = await this.ctx.foundryProjects();
    const p = projects.filter((x) => uri.fsPath.startsWith(x.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!p) return;
    const files = this.discoverProject(p);
    if (projects.length > 1) this.controller.items.get(p.root)?.children.replace(files);
    else this.controller.items.replace(files);
  }

  // ---- running ---------------------------------------------------------------------------------------------------

  /** The test leaves under the requested items. */
  private leaves(request: vscode.TestRunRequest): vscode.TestItem[] {
    const out: vscode.TestItem[] = [];
    const excluded = new Set(request.exclude?.map((i) => i.id));
    const visit = (item: vscode.TestItem) => {
      if (excluded.has(item.id)) return;
      if (this.data.get(item)?.kind === "test") out.push(item);
      item.children.forEach(visit);
    };
    if (request.include) request.include.forEach(visit);
    else this.controller.items.forEach(visit);
    return out;
  }

  private testData(item: vscode.TestItem): TestData {
    return this.data.get(item) as { kind: "test" } & TestData;
  }

  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken, withCoverage: boolean) {
    await this.discoverAll();
    if (request.continuous) return this.runContinuously(request, token, withCoverage);
    const run = this.controller.createTestRun(request);
    try {
      await this.runOnce(request, run, token, withCoverage);
    } finally {
      run.end();
    }
  }

  private runContinuously(request: vscode.TestRunRequest, token: vscode.CancellationToken, withCoverage: boolean) {
    let queued = false;
    let chain: Promise<void> = Promise.resolve();
    const again = () => {
      if (queued) return;
      queued = true;
      chain = chain.then(async () => {
        queued = false;
        if (token.isCancellationRequested) return;
        const run = this.controller.createTestRun(new vscode.TestRunRequest(request.include, request.exclude, request.profile, true));
        try {
          await this.runOnce(request, run, token, withCoverage);
        } finally {
          run.end();
        }
      });
    };
    const sub = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.fileName.endsWith(".sol")) again();
    });
    token.onCancellationRequested(() => sub.dispose());
    again();
  }

  private async runOnce(request: vscode.TestRunRequest, run: vscode.TestRun, token: vscode.CancellationToken, withCoverage: boolean) {
    const byProject = new Map<FoundryProject, vscode.TestItem[]>();
    for (const item of this.leaves(request)) {
      const d = this.testData(item);
      byProject.set(d.project, [...(byProject.get(d.project) ?? []), item]);
      run.enqueued(item);
    }
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      for (const [project, items] of byProject) {
        if (token.isCancellationRequested) break;
        const whole = this.coversProject(request, project, items.length);
        const groups: Group[] = whole ? [{ args: [], items }] : this.filterGroups(items);
        if (withCoverage) {
          await this.coverageRun(project, groups, run, abort.signal);
          continue;
        }
        const suites: SuiteResult[] = [];
        for (const g of groups) {
          if (token.isCancellationRequested) break;
          for (const i of g.items) run.started(i);
          const result = await this.forgeTest(project, g.args, run, abort.signal);
          if (result.cancelled) {
            for (const i of g.items) run.skipped(i);
            break;
          }
          if (!result.suites) {
            for (const i of g.items) run.errored(i, new vscode.TestMessage(result.error ?? "forge test failed"));
            continue;
          }
          suites.push(...result.suites);
          this.apply(project, result.suites, g.items, run);
        }
        if (suites.length) this.ctx.publishFoundryRun({ project, suites, complete: whole });
      }
    } finally {
      sub.dispose();
    }
  }

  /** True when every test of the project was asked for, so one unfiltered run does it. */
  private coversProject(request: vscode.TestRunRequest, project: FoundryProject, count: number): boolean {
    if (request.exclude?.length) return false;
    if (!request.include) return true;
    let total = 0;
    const visit = (i: vscode.TestItem) => {
      const d = this.data.get(i);
      if (d?.kind === "test" && d.project === project) total++;
      i.children.forEach(visit);
    };
    this.controller.items.forEach(visit);
    return total === count;
  }

  /** One forge invocation per test contract, with a test-name filter unless the whole contract was asked for. */
  private filterGroups(items: vscode.TestItem[]): Group[] {
    const byContract = new Map<string, { d: TestData; items: vscode.TestItem[] }>();
    for (const i of items) {
      const d = this.testData(i);
      const key = `${d.file}|${d.contract}`;
      const g = byContract.get(key) ?? { d, items: [] };
      g.items.push(i);
      byContract.set(key, g);
    }
    return [...byContract.values()].map(({ d, items }) => {
      const all = items[0].parent !== undefined && items[0].parent.children.size === items.length;
      const args = ["--match-path", d.file, "--match-contract", `^${escapeRe(d.contract)}$`];
      if (!all) args.push("--match-test", `^(${items.map((i) => escapeRe(this.testData(i).test.name)).join("|")})\\(`);
      return { args, items };
    });
  }

  private async forgeTest(project: FoundryProject, filter: string[], run: vscode.TestRun, signal: AbortSignal): Promise<{ suites?: SuiteResult[]; error?: string; cancelled?: boolean }> {
    const args = ["test", "--json", ...filter, ...setting<string[]>("tests.extraArgs", [])];
    run.appendOutput(`$ forge ${args.join(" ")}\r\n`);
    const r = await exec(tool("forge"), args, {
      cwd: project.root,
      signal,
      onLine: (line, stream) => {
        if (stream === "stderr") run.appendOutput(line + "\r\n");
      },
    });
    if (r.cancelled) return { cancelled: true };
    if (r.notFound) return { error: "forge was not found. Install Foundry, or set forgeDefender.paths.forge." };
    this.reportCompileErrors(project, r.stdout + "\n" + r.stderr);
    try {
      return { suites: parseTestJson(r.stdout) };
    } catch {
      const errors = parseCompilerMessages(r.stderr).filter((m) => m.severity === "error");
      const text = errors.length
        ? `The build failed:\n${errors.map((e) => `${e.file}:${e.line}: ${e.message}`).join("\n")}`
        : stripAnsi(r.stderr).trim() || "forge test printed no results";
      return { error: text };
    }
  }

  private reportCompileErrors(project: FoundryProject, output: string) {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const m of parseCompilerMessages(output)) {
      if (m.severity !== "error") continue;
      const file = path.resolve(project.root, m.file);
      const range = new vscode.Range(m.line - 1, Math.max(0, m.column - 1), m.line - 1, Number.MAX_SAFE_INTEGER);
      const d = new vscode.Diagnostic(range, m.message, vscode.DiagnosticSeverity.Error);
      d.source = "forge";
      if (m.code) d.code = m.code;
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
    this.compileErrors.forEach((uri) => {
      if (uri.fsPath.startsWith(project.root + path.sep)) this.compileErrors.delete(uri);
    });
    for (const [file, list] of byFile) this.compileErrors.set(vscode.Uri.file(file), list);
  }

  /** The item for a result, added under its contract when discovery missed it. */
  private itemFor(project: FoundryProject, file: string, contract: string, name: string, kind: TestOutcome["kind"]): vscode.TestItem | undefined {
    const id = `${project.root}|${file}|${contract}|${name}`;
    const existing = this.find(id);
    if (existing) return existing;
    const parent = this.find(`${project.root}|${file}|${contract}`);
    if (!parent) return undefined;
    const item = this.testItem(project, file, contract, { name, file, line: 0, kind: kind === "other" ? "unit" : kind });
    item.range = undefined;
    parent.children.add(item);
    return item;
  }

  private apply(project: FoundryProject, suites: SuiteResult[], requested: vscode.TestItem[], run: vscode.TestRun) {
    const seen = new Set<string>();
    const snapshot = this.snapshot(project);
    for (const suite of suites) {
      for (const t of suite.tests) {
        const item = this.itemFor(project, suite.file, suite.contract, t.name, t.kind);
        if (!item) continue;
        seen.add(item.id);
        const data = this.testData(item);
        this.last.set(item.id, { outcome: t, data });
        item.description = this.describe(data, t, snapshot);
        if (t.gas !== undefined) this.setGasDecoration(item, data, t, snapshot);
        for (const log of t.logs) run.appendOutput(`${log}\r\n`, undefined, item);
        if (t.status === "passed") run.passed(item, t.durationMs);
        else if (t.status === "skipped") run.skipped(item);
        else run.failed(item, this.failureMessages(item, t), t.durationMs);
      }
    }
    // Asked for, but not reported by forge: removed, renamed, or filtered out by the project's own settings.
    for (const item of requested) if (!seen.has(item.id)) run.skipped(item);
    this.paintGas();
  }

  private failureMessages(item: vscode.TestItem, t: TestOutcome): vscode.TestMessage[] {
    let text = t.reason ?? "Failed";
    const ce = t.counterexample;
    if (ce?.kind === "single") text += `\n\nCounterexample: ${ce.args || ce.calldata}`;
    if (ce?.kind === "sequence") {
      const calls = ce.calls.map((c) => `  ${c.contractName?.split(":").pop() ?? c.addr}.${c.signature ?? c.calldata}${c.args ? " " + c.args : ""}  (from ${c.sender})`);
      text += `\n\nAfter ${ce.calls.length} call(s):\n${calls.join("\n")}`;
    }
    if (ce) text += `\n\nRight-click this message to add it as a regression test.`;
    const message = new vscode.TestMessage(text);
    message.location = this.failureLocation(item, t);
    message.contextValue = ce ? "forgeDefender.counterexample" : "forgeDefender.failure";
    return [message];
  }

  /** The line of the require or assert whose message matches the reason, or the test's own line. */
  private failureLocation(item: vscode.TestItem, t: TestOutcome): vscode.Location | undefined {
    if (!item.uri || !item.range) return undefined;
    const fallback = new vscode.Location(item.uri, item.range);
    const reason = t.reason?.split(":")[0]?.trim();
    if (!reason || reason.length < 4) return fallback;
    try {
      const lines = fs.readFileSync(item.uri.fsPath, "utf8").split("\n");
      const start = item.range.start.line;
      for (let i = start; i < Math.min(lines.length, start + 400); i++) {
        if (i > start && /^\s*function\s/.test(lines[i])) break;
        if (lines[i].includes(`"${reason}"`)) return new vscode.Location(item.uri, new vscode.Range(i, 0, i, lines[i].length));
      }
    } catch {
      // the test line will do
    }
    return fallback;
  }

  // ---- gas -------------------------------------------------------------------------------------------------------

  private snapshot(project: FoundryProject): Map<string, SnapshotEntry> {
    try {
      return parseSnapshot(fs.readFileSync(path.join(project.root, ".gas-snapshot"), "utf8"));
    } catch {
      return new Map();
    }
  }

  private gasText(project: FoundryProject, contract: string, t: TestOutcome, snapshot = this.snapshot(project)): string {
    return describeGas(gasChange(t.gas!, snapshot.get(`${contract}:${t.signature}`)), t.gasLabel);
  }

  private setGasDecoration(item: vscode.TestItem, data: TestData, t: TestOutcome, snapshot: Map<string, SnapshotEntry>) {
    if (!item.uri || !item.range) return;
    // An inherited test runs once per contract; its line shows the gas of whichever ran last.
    const change = gasChange(t.gas!, snapshot.get(`${data.contract}:${t.signature}`));
    const threshold = setting<number>("gas.warnPercent", 1);
    const lines = this.gasByFile.get(item.uri.fsPath) ?? new Map();
    lines.set(item.range.start.line, { text: describeGas(change, t.gasLabel), worse: (change.percent ?? 0) > threshold });
    this.gasByFile.set(item.uri.fsPath, lines);
  }

  private paintGas() {
    const show = setting<boolean>("gas.showInline", true);
    for (const editor of vscode.window.visibleTextEditors) {
      const lines = show ? this.gasByFile.get(editor.document.uri.fsPath) : undefined;
      const decorations: vscode.DecorationOptions[] = [];
      for (const [line, g] of lines ?? []) {
        if (line >= editor.document.lineCount) continue;
        const end = editor.document.lineAt(line).range.end;
        decorations.push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: g.text, color: g.worse ? new vscode.ThemeColor("editorWarning.foreground") : undefined } },
        });
      }
      editor.setDecorations(this.gasDecoration, decorations);
    }
  }

  /** The gas shown at the end of a line, for the editor tests. */
  gasAt(file: string, line: number): string | undefined {
    return this.gasByFile.get(file)?.get(line)?.text;
  }

  // ---- coverage --------------------------------------------------------------------------------------------------

  /** Runs `forge coverage` and returns the parsed report. Used by the Coverage profile and by other features. */
  async coverage(project: FoundryProject, filter: string[], signal?: AbortSignal, onLine?: (line: string) => void): Promise<{ lcov?: Lcov; output: string; error?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forgedefender-cov-"));
    const report = path.join(dir, "lcov.info");
    const args = ["coverage", "--report", "lcov", "--report-file", report, ...filter, ...setting<string[]>("coverage.extraArgs", [])];
    onLine?.(`$ forge ${args.join(" ")}`);
    try {
      const r = await exec(tool("forge"), args, { cwd: project.root, signal, onLine: (l) => onLine?.(l) });
      if (r.notFound) return { output: "", error: "forge was not found. Install Foundry, or set forgeDefender.paths.forge." };
      const output = r.stdout + "\n" + r.stderr;
      this.reportCompileErrors(project, output);
      if (!fs.existsSync(report)) {
        const hint = /stack too deep/i.test(output) ? ' The build hit "stack too deep": add "--ir-minimum" to forgeDefender.coverage.extraArgs.' : "";
        return { output, error: `forge coverage wrote no report.${hint}` };
      }
      const lcov = parseLcov(fs.readFileSync(report, "utf8"));
      this.ctx.publishCoverage({ project, lcov });
      return { lcov, output };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async coverageRun(project: FoundryProject, groups: Group[], run: vscode.TestRun, signal: AbortSignal) {
    // One coverage run for everything asked: forge coverage instruments the whole build anyway.
    const items = groups.flatMap((g) => g.items);
    for (const i of items) run.started(i);
    const filter = groups.length === 1 ? groups[0].args : this.unionFilter(items);
    const r = await this.coverage(project, filter, signal, (l) => run.appendOutput(l + "\r\n"));
    if (signal.aborted) {
      for (const i of items) run.skipped(i);
      return;
    }
    const seen = new Set<string>();
    for (const o of parseTextResults(r.output)) {
      const item = this.itemFor(project, o.file, o.contract, o.name, "unit");
      if (!item) continue;
      seen.add(item.id);
      if (o.status === "passed") run.passed(item);
      else if (o.status === "skipped") run.skipped(item);
      else {
        const m = new vscode.TestMessage(o.reason ?? "Failed");
        if (item.uri && item.range) m.location = new vscode.Location(item.uri, item.range);
        run.failed(item, m);
      }
    }
    for (const i of items) {
      if (seen.has(i.id)) continue;
      if (r.error) run.errored(i, new vscode.TestMessage(r.error));
      else run.skipped(i);
    }
    if (r.lcov) for (const fc of this.fileCoverage(project, r.lcov)) run.addCoverage(fc);
  }

  /** One filter matching several contracts' tests, for a single coverage run. */
  private unionFilter(items: vscode.TestItem[]): string[] {
    const contracts = new Set<string>();
    const tests = new Set<string>();
    for (const i of items) {
      const d = this.testData(i);
      contracts.add(escapeRe(d.contract));
      tests.add(escapeRe(d.test.name));
    }
    return ["--match-contract", `^(${[...contracts].join("|")})$`, "--match-test", `^(${[...tests].join("|")})\\(`];
  }

  private fileCoverage(project: FoundryProject, lcov: Lcov): vscode.FileCoverage[] {
    const out: vscode.FileCoverage[] = [];
    for (const f of lcov) {
      const uri = vscode.Uri.file(path.resolve(project.root, f.file));
      const branchesByLine = new Map<number, vscode.BranchCoverage[]>();
      for (const b of f.branches) {
        const list = branchesByLine.get(b.line) ?? [];
        list.push(new vscode.BranchCoverage(b.hits, new vscode.Position(b.line - 1, 0), `branch ${b.branch}`));
        branchesByLine.set(b.line, list);
      }
      const details: vscode.FileCoverageDetail[] = [];
      for (const [line, hits] of f.lines) {
        details.push(new vscode.StatementCoverage(hits, new vscode.Position(line - 1, 0), branchesByLine.get(line) ?? []));
      }
      for (const fn of f.functions) {
        details.push(new vscode.DeclarationCoverage(fn.name, fn.hits, new vscode.Position(Math.max(0, fn.line - 1), 0)));
      }
      const fc = vscode.FileCoverage.fromDetails(uri, details);
      this.coverageDetails.set(fc, details);
      out.push(fc);
    }
    return out;
  }

  // ---- debugging -------------------------------------------------------------------------------------------------

  private debugInTerminal(request: vscode.TestRunRequest) {
    const item = this.leaves(request)[0];
    if (!item) return;
    const d = this.testData(item);
    const terminal = vscode.window.createTerminal({ name: `forge debug ${d.test.name}`, cwd: d.project.root });
    terminal.show();
    terminal.sendText(
      [tool("forge"), "test", "--debug", "--match-path", d.file, "--match-contract", `^${d.contract}$`, "--match-test", `^${d.test.name}\\(`].map(shellQuote).join(" "),
    );
  }

  // ---- regression tests ------------------------------------------------------------------------------------------

  async addRegression(item: vscode.TestItem | undefined): Promise<string | undefined> {
    const last = item && this.last.get(item.id);
    if (!item || !last?.outcome.counterexample) {
      void vscode.window.showInformationMessage("Run the test first: a regression test is made from a failing fuzz or invariant run.");
      return undefined;
    }
    const { data, outcome } = last;
    const doc = await vscode.workspace.openTextDocument(path.join(data.project.root, data.file));
    const src = doc.getText();
    const contract = parseSolidity(src).contracts.find((c) => c.name === data.contract);
    if (!contract) return undefined;
    const sources = this.testSources(data.project);
    const fn = sources
      .get(data.test.file)
      ?.contracts.flatMap((c) => c.functions)
      .find((f) => f.name === data.test.name);
    const hasVm = importsForgeStd(src) || this.chainFiles(data, sources).some((f) => importsForgeStd(readText(path.join(data.project.root, f))));
    const { name, code } = regressionTest({
      testName: data.test.name,
      params: fn?.params ?? "",
      counterexample: outcome.counterexample!,
      existing: new Set(contract.functions.map((f) => f.name)),
      hasVm,
    });
    const at = insertion(src, data.contract, code);
    if (!at) return undefined;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(at.offset), at.text);
    await vscode.workspace.applyEdit(edit);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = doc.positionAt(at.offset + at.text.indexOf(`function ${name}`));
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    return name;
  }

  /** Files defining the contract and its bases, as far as the test sources show. */
  private chainFiles(data: TestData, sources: Map<string, SolFile>): string[] {
    const where = new Map<string, { file: string; bases: string[] }>();
    for (const [file, parsed] of sources) for (const c of parsed.contracts) if (!where.has(c.name)) where.set(c.name, { file, bases: c.bases });
    const files = new Set<string>();
    const queue = [data.contract];
    const seen = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const w = where.get(name);
      if (!w) continue;
      files.add(w.file);
      queue.push(...w.bases);
    }
    return [...files];
  }

  /** The item with this id, if it is in the tree. */
  find(id: string): vscode.TestItem | undefined {
    let hit: vscode.TestItem | undefined;
    const visit = (i: vscode.TestItem) => {
      if (hit) return;
      if (i.id === id) hit = i;
      else if (id.startsWith(i.id + "|")) i.children.forEach(visit);
    };
    this.controller.items.forEach(visit);
    return hit;
  }

  dataOf(item: vscode.TestItem): ItemData | undefined {
    return this.data.get(item);
  }

  dispose() {
    clearTimeout(this.sourceTimer);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

function escapeRe(s: string): string {
  return s.replace(/[$]/g, "\\$");
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function shellQuote(s: string): string {
  return /^[\w./:@^$=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function register(ctx: Ctx): void {
  const tests = new FoundryTests(ctx);
  ctx.foundryTests = tests;
  ctx.subscriptions.push(
    tests,
    vscode.commands.registerCommand("forgeDefender.tests.addRegression", (arg?: vscode.TestItem | { test: vscode.TestItem }) =>
      tests.addRegression(arg && "test" in arg ? arg.test : arg),
    ),
    vscode.commands.registerCommand("forgeDefender.tests.updateSnapshot", async () => {
      const project = await ctx.pickFoundryProject();
      if (!project) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Updating the gas snapshot" }, async () => {
        const r = await exec(tool("forge"), ["snapshot"], { cwd: project.root });
        if (r.notFound) void vscode.window.showErrorMessage("forge was not found. Install Foundry, or set forgeDefender.paths.forge.");
        else if (r.code !== 0) void vscode.window.showWarningMessage("Some tests failed, so the snapshot holds only the passing ones.");
      });
    }),
    vscode.commands.registerCommand("forgeDefender.coverage.run", async (root?: string) => {
      const project = root ? (await ctx.foundryProjects()).find((p) => p.root === root) : await ctx.pickFoundryProject();
      if (!project) return undefined;
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Measuring coverage", cancellable: true }, async (_p, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const r = await tests.coverage(project, [], abort.signal, (l) => ctx.log.trace(l));
        if (r.error) void vscode.window.showWarningMessage(r.error);
        return r.lcov;
      });
    }),
  );
  void tests.discoverAll();
}
