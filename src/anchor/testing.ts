import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec, stripAnsi } from "../core/exec";
import { setting, tool } from "../core/tools";
import { shownArgs } from "../chain/chains";
import { runInTerminal } from "../chain/terminal";
import { walk, projectOf, type AnchorProject } from "../core/projects";
import { readAnchorConfig, type AnchorConfig } from "./config";
import { anchorRuns } from "./events";
import { discoverMocha, type MochaNode } from "./mocha";
import { reporterSource } from "./reporter";
import { globToRegExp, grepFor, isMochaScript, parseMarker, parseSpec, runProblem, scriptArgs, stackLocation, type TestResult } from "./run";

// Anchor's mocha tests in the Testing view. Discovery reads the test files; a run is `anchor test` with our
// reporter added, so results arrive per test as they happen. Only localnet runs here: on any other cluster
// `anchor test` deploys, and deploys belong in a terminal where keymoat can ask first.

interface Meta {
  kind: "project" | "file" | "suite" | "test";
  root: string;
  file?: string;
  path: string[];
}

export interface RunSummary {
  /** Test item id → outcome. */
  results: Record<string, { state: string; message?: string; durationMs?: number }>;
  output: string;
  problem?: string;
}

const testExtensions = [".ts", ".js", ".mjs", ".cjs"];

export function register(ctx: Ctx): void {
  const controller = vscode.tests.createTestController("forgeDefender.anchor", "Anchor");
  ctx.subscriptions.push(controller);
  const meta = new WeakMap<vscode.TestItem, Meta>();
  let projects: AnchorProject[] = [];
  let lastRun: RunSummary | undefined;

  // VS Code does not allow a NUL in test ids, so the title path is kept as JSON.
  const itemId = (file: string, p: string[]) => JSON.stringify([file, ...p]);

  const container = (root: string): vscode.TestItemCollection => {
    if (projects.length <= 1) return controller.items;
    return controller.items.get(`anchor:${root}`)?.children ?? controller.items;
  };

  const addNodes = (parent: vscode.TestItem, root: string, file: string, nodes: MochaNode[], prefix: string[]) => {
    const uri = vscode.Uri.file(file);
    for (const n of nodes) {
      const p = [...prefix, n.title];
      const item = controller.createTestItem(itemId(file, p), n.title, uri);
      item.range = new vscode.Range(n.line, n.col, n.line, n.col);
      if (n.modifier) {
        item.tags = [new vscode.TestTag(n.modifier)];
        item.description = n.modifier === "skip" ? "skipped" : "only";
      }
      meta.set(item, { kind: n.kind, root, file, path: p });
      parent.children.add(item);
      addNodes(item, root, file, n.children, p);
    }
  };

  const discoverFile = (project: AnchorProject, file: string) => {
    const items = container(project.root);
    let nodes: MochaNode[] = [];
    try {
      nodes = discoverMocha(fs.readFileSync(file, "utf8"));
    } catch {
      // A file that went away just loses its tests.
    }
    const id = `file:${file}`;
    if (!nodes.length) {
      items.delete(id);
      return;
    }
    const item = controller.createTestItem(id, path.relative(project.root, file), vscode.Uri.file(file));
    meta.set(item, { kind: "file", root: project.root, file, path: [] });
    addNodes(item, project.root, file, nodes, []);
    items.add(item);
  };

  const isTestFile = (project: AnchorProject, cfg: AnchorConfig, file: string) => {
    if (!testExtensions.some((e) => file.endsWith(e))) return false;
    const rel = path.relative(project.root, file).split(path.sep).join("/");
    if (rel.startsWith("..") || /(^|\/)(node_modules|target)\//.test(rel)) return false;
    return cfg.testGlobs.some((g) => globToRegExp(g).test(rel));
  };

  const discoverProject = (project: AnchorProject) => {
    const cfg = readAnchorConfig(project.root);
    for (const file of walk(project.root, testExtensions, ["node_modules", "target", ".git", ".anchor"])) {
      if (isTestFile(project, cfg, file)) discoverFile(project, file);
    }
  };

  const discoverAll = async () => {
    projects = await ctx.anchorProjects();
    controller.items.replace([]);
    if (projects.length > 1) {
      for (const p of projects) {
        const item = controller.createTestItem(`anchor:${p.root}`, p.name, vscode.Uri.file(p.root));
        meta.set(item, { kind: "project", root: p.root, path: [] });
        controller.items.add(item);
      }
    }
    for (const p of projects) discoverProject(p);
  };

  const rediscover = () => {
    discovered = discoverAll().catch((e) => ctx.log.error(`Anchor test discovery: ${e}`));
    return discovered;
  };
  let discovered: Promise<void> = Promise.resolve();
  void rediscover();
  controller.resolveHandler = async (item) => {
    if (!item) await discovered;
  };
  controller.refreshHandler = () => rediscover();
  ctx.subscriptions.push(ctx.onDidChangeProjects(() => void rediscover()));

  // Watcher events can name a file by its real path (/private/var/... on macOS) while the project root was found
  // through a symlinked one, so a file is matched on either spelling and then named the way the root is.
  const locate = (uri: vscode.Uri): { project: AnchorProject; file: string } | undefined => {
    const direct = projectOf(projects, uri.fsPath);
    if (direct) return { project: direct, file: uri.fsPath };
    for (const p of projects) {
      let real: string;
      try {
        real = fs.realpathSync(p.root);
      } catch {
        continue;
      }
      if (uri.fsPath.startsWith(real + path.sep)) return { project: p, file: path.join(p.root, uri.fsPath.slice(real.length + 1)) };
    }
    return undefined;
  };
  const onFile = (uri: vscode.Uri) => {
    const at = locate(uri);
    if (at && isTestFile(at.project, readAnchorConfig(at.project.root), at.file)) discoverFile(at.project, at.file);
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.{ts,js,mjs,cjs}");
  watcher.onDidChange(onFile);
  watcher.onDidCreate(onFile);
  watcher.onDidDelete((uri) => {
    const at = locate(uri);
    if (at) container(at.project.root).delete(`file:${at.file}`);
  });
  // Edits made in the editor arrive here at once; the watcher covers changes made outside it.
  ctx.subscriptions.push(
    watcher,
    vscode.workspace.onDidSaveTextDocument((d) => onFile(d.uri)),
    vscode.workspace.onDidCreateFiles((e) => e.files.forEach(onFile)),
    vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => (onFile(f.oldUri), onFile(f.newUri)))),
    vscode.workspace.onDidDeleteFiles((e) => e.files.forEach(onFile)),
  );

  // Results ---------------------------------------------------------------------------------------------------

  const leaves = (item: vscode.TestItem): vscode.TestItem[] => {
    if (meta.get(item)?.kind === "test") return [item];
    const out: vscode.TestItem[] = [];
    item.children.forEach((c) => out.push(...leaves(c)));
    return out;
  };

  const projectFiles = (root: string): vscode.TestItem[] => {
    const out: vscode.TestItem[] = [];
    container(root).forEach((i) => {
      if (meta.get(i)?.kind === "file") out.push(i);
    });
    return out;
  };

  const find = (root: string, file: string | undefined, p: string[]): vscode.TestItem | undefined => {
    const files = file ? [container(root).get(`file:${file}`)].filter((f): f is vscode.TestItem => !!f) : projectFiles(root);
    for (const f of files) {
      const fileName = meta.get(f)!.file!;
      let cur: vscode.TestItem | undefined = f;
      for (let i = 0; i < p.length && cur; i++) cur = cur.children.get(itemId(fileName, p.slice(0, i + 1)));
      if (cur) return cur;
    }
    return undefined;
  };

  // A test whose title is built at run time is added when the run reports it.
  const findOrCreate = (root: string, file: string | undefined, p: string[]): vscode.TestItem | undefined => {
    const found = find(root, file, p);
    if (found || !file || !p.length) return found;
    let parent: vscode.TestItem | undefined = container(root).get(`file:${file}`);
    if (!parent) {
      parent = controller.createTestItem(`file:${file}`, path.relative(root, file), vscode.Uri.file(file));
      meta.set(parent, { kind: "file", root, file, path: [] });
      container(root).add(parent);
    }
    for (let i = 0; i < p.length; i++) {
      const id = itemId(file, p.slice(0, i + 1));
      let next: vscode.TestItem | undefined = parent.children.get(id);
      if (!next) {
        next = controller.createTestItem(id, p[i], vscode.Uri.file(file));
        meta.set(next, { kind: i === p.length - 1 ? "test" : "suite", root, file, path: p.slice(0, i + 1) });
        parent.children.add(next);
      }
      parent = next;
    }
    return parent;
  };

  // Points at the failing line when the stack trace goes through the test file, else at the test itself.
  const failureMessage = (r: TestResult, item: vscode.TestItem): vscode.TestMessage => {
    const text = [r.hook ? `${r.hook} failed` : "", r.message ?? "Failed"].filter(Boolean).join(": ");
    const msg =
      r.expected !== undefined && r.actual !== undefined
        ? vscode.TestMessage.diff(text, r.expected, r.actual)
        : new vscode.TestMessage(r.stack && !r.stack.includes(text) ? `${text}\n\n${r.stack}` : r.stack ?? text);
    const loc = r.file ? stackLocation(r.stack, r.file) : undefined;
    if (r.file && loc) msg.location = new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(loc.line, loc.col));
    else if (item.uri && item.range) msg.location = new vscode.Location(item.uri, item.range);
    return msg;
  };

  // Running ---------------------------------------------------------------------------------------------------

  const reporterPath = (): string => {
    const dir = ctx.extension.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "anchor-mocha-reporter.cjs");
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== reporterSource) fs.writeFileSync(file, reporterSource);
    return file;
  };

  const runProject = async (
    run: vscode.TestRun,
    project: AnchorProject,
    selected: vscode.TestItem[] | "all",
    token: vscode.CancellationToken,
    summary: RunSummary,
  ) => {
    const cfg = readAnchorConfig(project.root);
    const extra = setting<string[]>("anchor.testArgs", []).filter((a) => typeof a === "string" && a.trim());
    const all = selected === "all" ? projectFiles(project.root).flatMap(leaves) : [...new Set(selected.flatMap(leaves))];
    for (const t of all) run.enqueued(t);
    const done = new Set<vscode.TestItem>();
    const out = (text: string) => {
      summary.output += text + "\n";
      run.appendOutput(text.replace(/\r?\n/g, "\r\n") + "\r\n");
    };
    const fail = (problem: string) => {
      summary.problem = problem;
      out(problem);
      for (const t of all) {
        if (done.has(t)) continue;
        run.errored(t, new vscode.TestMessage(problem));
        summary.results[t.id] = { state: "errored", message: problem };
      }
    };

    const skipsValidator = extra.includes("--skip-local-validator");
    if (!cfg.localnet || (skipsValidator && !extra.includes("--skip-deploy"))) {
      const where = cfg.localnet ? "the configured cluster" : cfg.cluster;
      fail(`These tests would deploy to ${where}. ForgeDefender only runs localnet tests here; run \`anchor test\` in a terminal instead.`);
      void vscode.window
        .showWarningMessage(`${project.name}: \`anchor test\` deploys to ${where}. Type the command in a terminal?`, "Open Terminal")
        .then((pick) => {
          if (pick !== "Open Terminal") return;
          // Typed but not sent: the person presses Enter, and keymoat asks there before anything is signed.
          runInTerminal({ name: `anchor test: ${project.name}`, cwd: project.root, args: [tool("anchor"), "test", ...extra], send: false });
        });
      return;
    }
    if (!skipsValidator) {
      for (const port of [cfg.rpcPort, cfg.faucetPort]) {
        if (await portInUse(port)) {
          const problem = `Port ${port} is already in use, usually by a solana-test-validator left running from an earlier run. Stop it and run the tests again.`;
          fail(problem);
          void vscode.window.showWarningMessage(`${project.name}: ${problem}`);
          return;
        }
      }
    }

    const mocha = cfg.testScript !== undefined && isMochaScript(cfg.testScript);
    const mochaArgs: string[] = [];
    if (mocha) {
      mochaArgs.push("--reporter", reporterPath());
      if (selected !== "all") {
        // Suites and files become their tests' exact titles: a title prefix for suite "A" would also run a
        // sibling suite "A B". Only a suite with no tests known before the run (titles built at run time) is
        // matched by its prefix.
        const pick = (i: vscode.TestItem): { path: string[]; kind: "suite" | "test" }[] => {
          const m = meta.get(i)!;
          if (m.kind === "test") return [{ path: m.path, kind: "test" }];
          const inner: { path: string[]; kind: "suite" | "test" }[] = [];
          i.children.forEach((c) => inner.push(...pick(c)));
          return inner.length || m.kind === "file" ? inner : [{ path: m.path, kind: "suite" }];
        };
        const grep = grepFor(selected.flatMap(pick));
        if (grep) mochaArgs.push("--grep", grep);
      }
    } else if (selected !== "all") {
      out("This project's test script does not run mocha directly, so all of its tests run.");
    }
    const positional = scriptArgs(mochaArgs);
    const args = ["test", ...extra, ...(positional ? [positional] : [])];
    out(`> anchor ${shownArgs(args.map((a) => a.trim()))}`);

    // mocha reports real paths; the project may have been found through a symlink.
    let realRoot = project.root;
    try {
      realRoot = fs.realpathSync(project.root);
    } catch {
      // keep the root as found
    }
    const ownSpelling = (file: string | undefined) =>
      file && realRoot !== project.root && file.startsWith(realRoot + path.sep) ? path.join(project.root, file.slice(realRoot.length + 1)) : file;

    let sawMarker = false;
    const apply = (raw: TestResult) => {
      const r = { ...raw, file: ownSpelling(raw.file), stack: raw.stack && realRoot !== project.root ? raw.stack.split(realRoot + path.sep).join(project.root + path.sep) : raw.stack };
      if (r.hook) {
        const scope = r.path.length ? find(project.root, r.file, r.path) : undefined;
        for (const t of scope ? leaves(scope) : all) {
          if (done.has(t)) continue;
          done.add(t);
          run.failed(t, failureMessage({ ...r, file: r.file ?? meta.get(t)?.file }, t));
          summary.results[t.id] = { state: "failed", message: r.message };
        }
        return;
      }
      const item = findOrCreate(project.root, r.file, r.path);
      if (!item) return;
      if (r.state === "started") {
        run.started(item);
        return;
      }
      done.add(item);
      summary.results[item.id] = { state: r.state, message: r.message, durationMs: r.durationMs };
      if (r.state === "passed") run.passed(item, r.durationMs);
      else if (r.state === "skipped") run.skipped(item);
      else run.failed(item, failureMessage({ ...r, file: r.file ?? meta.get(item)?.file }, item), r.durationMs);
    };

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    const result = await exec(tool("anchor"), args, {
      cwd: project.root,
      signal: abort.signal,
      env: { FORCE_COLOR: "0", NO_COLOR: "1" },
      onLine: (raw) => {
        const line = stripAnsi(raw);
        const marker = parseMarker(line);
        if (marker === "end") sawMarker = true;
        else if (marker) {
          sawMarker = true;
          apply(marker);
        } else out(line);
      },
    });
    sub.dispose();

    if (result.notFound) {
      fail("anchor was not found. Install the Anchor CLI, or set forgeDefender.paths.anchor.");
      return;
    }
    if (!sawMarker) for (const r of parseSpec(stripAnsi(result.stdout))) apply(r);
    const pending = all.filter((t) => !done.has(t));
    if (result.cancelled) {
      for (const t of pending) run.skipped(t);
    } else if (done.size === 0 && result.code !== 0) {
      fail(runProblem(stripAnsi(result.stdout + "\n" + result.stderr)) ?? `anchor test exited with code ${result.code} before any test ran. See the test output.`);
    } else {
      for (const t of pending) {
        run.skipped(t);
        summary.results[t.id] = { state: "skipped" };
      }
    }
    anchorRuns.fire({ root: project.root, ok: result.code === 0 });
  };

  const runHandler = async (request: vscode.TestRunRequest, token: vscode.CancellationToken) => {
    await discovered;
    const run = controller.createTestRun(request);
    const summary: RunSummary = { results: {}, output: "" };
    const groups = new Map<string, vscode.TestItem[] | "all">();
    if (!request.include) for (const p of projects) groups.set(p.root, "all");
    else {
      for (const item of request.include) {
        const m = meta.get(item);
        if (!m) continue;
        const g = groups.get(m.root);
        if (m.kind === "project" || g === "all") groups.set(m.root, "all");
        else groups.set(m.root, [...(g ?? []), item]);
      }
    }
    try {
      for (const [root, selected] of groups) {
        if (token.isCancellationRequested) break;
        const project = projects.find((p) => p.root === root);
        if (project) await runProject(run, project, selected, token, summary);
      }
    } finally {
      run.end();
      lastRun = summary;
    }
  };

  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);

  const discoveredTests = async () => {
    await discovered;
    const dump = (items: vscode.TestItemCollection): object[] => {
      const out: object[] = [];
      items.forEach((i) =>
        out.push({ id: i.id, label: i.label, line: i.range?.start.line, tags: i.tags.map((t) => t.id), children: dump(i.children) }),
      );
      return out;
    };
    return dump(controller.items);
  };
  const runTests = async (ids?: string[]) => {
    await discovered;
    const byId = new Map<string, vscode.TestItem>();
    const index = (items: vscode.TestItemCollection) =>
      items.forEach((i) => {
        byId.set(i.id, i);
        index(i.children);
      });
    index(controller.items);
    const include = ids?.map((id) => byId.get(id)).filter((i): i is vscode.TestItem => !!i);
    const cts = new vscode.CancellationTokenSource();
    await runHandler(new vscode.TestRunRequest(include), cts.token);
    cts.dispose();
    return lastRun;
  };
  // For the editor tests: the discovered tree, and a run of given item ids.
  ctx.api.set("anchorTesting", { discoveredTests, runTests });
}

/** True when something accepts connections on the port, like a validator left running. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const finish = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
