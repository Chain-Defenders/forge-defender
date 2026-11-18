import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec, stripAnsi } from "../core/exec";
import { projectOf, type FoundryProject } from "../core/projects";
import { setting, tool } from "../core/tools";
import { engineById, engines, slitherWiki, type Engine, type Finding, type FindingSeverity } from "./engines";
import { lastLines } from "./ui";

// Static analysis in the editor: runs an engine on a Foundry project and shows its findings as diagnostics, one
// collection per engine. Findings only in dependencies are left out.

const severity: Record<FindingSeverity, vscode.DiagnosticSeverity> = {
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
  info: vscode.DiagnosticSeverity.Information,
  optimization: vscode.DiagnosticSeverity.Hint,
};

const installed = new Map<string, boolean>();

async function isInstalled(e: Engine): Promise<boolean> {
  const bin = tool(e.tool);
  if (!installed.has(bin)) {
    const r = await exec(bin, ["--version"], { cwd: os.homedir(), timeoutMs: 30_000 });
    // Only a found tool is remembered, so installing one works without reloading the window.
    if (!r.notFound && r.code === 0) installed.set(bin, true);
    else return false;
  }
  return true;
}

/** The engine the setting asks for; with "auto", Slither when installed, else Aderyn. */
export async function chooseEngine(): Promise<Engine | undefined> {
  const wanted = setting<string>("security.analysis.engine", "auto");
  if (wanted !== "auto") {
    const e = engineById(wanted);
    return e && (await isInstalled(e)) ? e : undefined;
  }
  for (const e of engines) if (await isInstalled(e)) return e;
  return undefined;
}

async function loadSlitherWiki(root: string) {
  if (slitherWiki.size) return;
  const r = await exec(tool("slither"), ["--list-detectors-json"], { cwd: root, timeoutMs: 60_000 });
  try {
    for (const d of JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))) if (d.check && d.wiki_url) slitherWiki.set(d.check, d.wiki_url);
  } catch {
    // The generic documentation page is used instead.
  }
}

export async function runEngine(e: Engine, project: FoundryProject, log: (line: string) => void, signal?: AbortSignal): Promise<Finding[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-analysis-"));
  const outFile = path.join(dir, "report.json");
  try {
    if (e.id === "slither") await loadSlitherWiki(project.root);
    const r = await exec(tool(e.tool), e.args(outFile), {
      cwd: project.root,
      timeoutMs: 30 * 60_000,
      signal,
      onLine: (l, s) => (s === "stderr" || e.output === "file") && l.trim() && log(stripAnsi(l)),
    });
    if (r.notFound) throw new Error(`${e.label} is not installed or not on the PATH`);
    if (r.timedOut) throw new Error(`${e.label} ran for 30 minutes without finishing and was stopped`);
    if (r.cancelled) throw new Error(`${e.label} was stopped`);
    let json: string;
    if (e.output === "file") {
      if (!fs.existsSync(outFile)) throw new Error(`${e.label} wrote no report: ${lastLines(stripAnsi(r.stderr || r.stdout))}`);
      json = fs.readFileSync(outFile, "utf8");
    } else {
      // Slither exits non-zero when it finds something; the JSON's own success flag says whether it ran.
      if (!r.stdout.includes("{")) throw new Error(`${e.label} failed: ${lastLines(stripAnsi(r.stderr))}`);
      json = r.stdout;
    }
    return e.parse(json);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function register(ctx: Ctx): void {
  const collections = new Map<string, vscode.DiagnosticCollection>();
  for (const e of engines) {
    const c = vscode.languages.createDiagnosticCollection(`forgeDefender.${e.id}`);
    collections.set(e.id, c);
    ctx.subscriptions.push(c);
  }
  const running = new Map<string, AbortController>();

  function publish(e: Engine, project: FoundryProject, findings: Finding[]) {
    const c = collections.get(e.id)!;
    // Replace only this project's findings: another project in the workspace keeps its own.
    c.forEach((uri) => {
      if (projectOf([project], uri.fsPath)) c.delete(uri);
    });
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const f of findings) {
      const file = path.join(project.root, f.file);
      const end = f.endLine && f.endLine - f.line < 10 ? f.endLine : f.line;
      const d = new vscode.Diagnostic(new vscode.Range(f.line - 1, 0, end - 1, 1000), f.title, severity[f.severity]);
      d.source = e.label;
      d.code = f.docs ? { value: f.detector, target: vscode.Uri.parse(f.docs) } : f.detector;
      if (f.related.length) {
        d.relatedInformation = f.related.map(
          (r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(path.join(project.root, r.file)), new vscode.Position(r.line - 1, 0)), "Also here"),
        );
      }
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
    for (const [file, list] of byFile) c.set(vscode.Uri.file(file), list);
  }

  async function analyse(project: FoundryProject, quiet: boolean): Promise<Finding[] | undefined> {
    const e = await chooseEngine();
    if (!e) {
      const wanted = setting<string>("security.analysis.engine", "auto");
      if (!quiet) {
        void vscode.window.showWarningMessage(
          wanted === "auto"
            ? "No static analyser found. Install Slither (pip install slither-analyzer) or Aderyn (cyfrinup), or set its path in forgeDefender.paths."
            : `${engineById(wanted)?.label ?? wanted} is not installed or not on the PATH.`,
        );
      }
      return undefined;
    }
    running.get(project.root)?.abort();
    const ac = new AbortController();
    running.set(project.root, ac);
    const work = async () => {
      ctx.log.info(`${e.label} on ${project.name}`);
      const findings = await runEngine(e, project, (l) => ctx.log.debug(`${e.id}: ${l}`), ac.signal);
      publish(e, project, findings);
      ctx.log.info(`${e.label}: ${findings.length} findings in ${project.name}`);
      return findings;
    };
    try {
      const findings = quiet
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${e.label}` }, work)
        : await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Running ${e.label}`, cancellable: true }, (_p, token) => {
            token.onCancellationRequested(() => ac.abort());
            return work();
          });
      if (!quiet) {
        const n = findings.length;
        void vscode.window.showInformationMessage(n ? `${e.label}: ${n} ${n === 1 ? "finding" : "findings"}. See Problems.` : `${e.label} found nothing.`);
      }
      return findings;
    } catch (err) {
      if (ac.signal.aborted) return undefined;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log.error(`${e.label}: ${msg}`);
      if (!quiet) void vscode.window.showErrorMessage(`${msg}`);
      return undefined;
    } finally {
      if (running.get(project.root) === ac) running.delete(project.root);
    }
  }

  const timers = new Map<string, NodeJS.Timeout>();
  ctx.subscriptions.push(
    vscode.commands.registerCommand("forgeDefender.security.runAnalysis", async (root?: unknown, quiet?: boolean) => {
      const project = typeof root === "string" ? (await ctx.foundryProjects()).find((p) => p.root === root) : await ctx.pickFoundryProject();
      if (!project) return undefined;
      return analyse(project, quiet === true);
    }),
    vscode.commands.registerCommand("forgeDefender.security.clearAnalysis", () => {
      for (const c of collections.values()) c.clear();
    }),
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!doc.uri.fsPath.endsWith(".sol") || !setting("security.analysis.onSave", false)) return;
      const project = projectOf(await ctx.foundryProjects(), doc.uri.fsPath);
      if (!project) return;
      // Saving several files in a row runs one analysis.
      clearTimeout(timers.get(project.root));
      timers.set(
        project.root,
        setTimeout(() => void analyse(project, true), 1000),
      );
    }),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    { dispose: () => running.forEach((a) => a.abort()) },
  );
}
