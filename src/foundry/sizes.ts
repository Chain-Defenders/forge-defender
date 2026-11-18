import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { listArtifacts } from "../core/artifacts";
import { exec, stripAnsi } from "../core/exec";
import type { FoundryProject } from "../core/projects";
import { parseSolidity } from "../core/solidity";
import { setting, tool } from "../core/tools";
import { ContractSize, judgeSize, parseSizes } from "../chain/sizes";

// Contract sizes: `forge build --sizes --json` after each test run and on demand, with a warning on the contract's
// declaration from 90% of a limit and an error over it. Scripts and tests are left out: they are never deployed.

export function register(ctx: Ctx): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("forgeDefender.sizes");
  const last = new Map<string, Map<string, ContractSize>>();
  const running = new Map<string, Promise<void>>();

  const check = (project: FoundryProject): Promise<void> => {
    const busy = running.get(project.root);
    if (busy) return busy;
    const p = checkProject(ctx, project, diagnostics, last).finally(() => running.delete(project.root));
    running.set(project.root, p);
    return p;
  };

  ctx.api.set("sizes", {
    snapshot: () => Object.fromEntries([...last].map(([root, sizes]) => [root, Object.fromEntries(sizes)])),
    check,
  });
  ctx.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand("forgeDefender.sizes.check", async () => {
      const projects = await ctx.foundryProjects();
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Checking contract sizes" }, () => Promise.all(projects.map(check)));
    }),
    ctx.onDidRunFoundryTests((e) => {
      if (setting<boolean>("sizes.afterTests", true)) void check(e.project);
    }),
  );
}

async function checkProject(
  ctx: Ctx,
  project: FoundryProject,
  diagnostics: vscode.DiagnosticCollection,
  last: Map<string, Map<string, ContractSize>>,
): Promise<void> {
  const r = await exec(tool("forge"), ["build", "--sizes", "--json"], { cwd: project.root, timeoutMs: 600_000 });
  let sizes: Map<string, ContractSize>;
  try {
    // forge exits with 1 when a contract is over a limit, and still prints the table.
    sizes = parseSizes(stripAnsi(r.stdout));
  } catch {
    ctx.log.warn(`Contract sizes: forge build --sizes failed in ${project.name} (exit code ${r.code}): ${stripAnsi(r.stderr).trim().slice(0, 500)}`);
    return;
  }
  last.set(project.root, sizes);

  const skip = [project.config.test, project.config.script].map((d) => path.resolve(project.root, d) + path.sep);
  const artifacts = listArtifacts(project.root, project.config.out).filter((a) => a.source && !skip.some((s) => path.resolve(project.root, a.source).startsWith(s)));
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const parsed = new Map<string, ReturnType<typeof parseSolidity> | undefined>();

  for (const [key, size] of sizes) {
    // A key is "Name", or "path:Name" when two contracts share a name.
    const i = key.lastIndexOf(":");
    const name = i === -1 ? key : key.slice(i + 1);
    const source = i === -1 ? undefined : key.slice(0, i);
    const finding = judgeSize(name, size);
    if (!finding) continue;
    for (const a of artifacts.filter((x) => x.name === name && (!source || x.source === source))) {
      const file = path.resolve(project.root, a.source);
      if (!parsed.has(file)) {
        try {
          parsed.set(file, parseSolidity(fs.readFileSync(file, "utf8")));
        } catch {
          parsed.set(file, undefined);
        }
      }
      const c = parsed.get(file)?.contracts.find((x) => x.name === name);
      const line = c?.line ?? 0;
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        finding.message,
        finding.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      d.source = "ForgeDefender";
      d.code = "contract-size";
      byFile.set(file, [...(byFile.get(file) ?? []), d]);
    }
  }

  // Replace this project's earlier findings only.
  const stale: vscode.Uri[] = [];
  diagnostics.forEach((uri) => {
    if (uri.fsPath.startsWith(project.root + path.sep) && !byFile.has(uri.fsPath)) stale.push(uri);
  });
  for (const uri of stale) diagnostics.delete(uri);
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
}
