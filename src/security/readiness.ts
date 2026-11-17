import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { links, siteLink } from "../core/links";
import { walk, type FoundryProject } from "../core/projects";
import { parseLcov, type Lcov } from "../foundry/lcov";
import { readinessHtml } from "./html";
import { buildReport, coveragePercent, scopeText, type ReadinessReport, type TestCounts } from "./report";
import { commandLink, openLink, registerOpenLocation, relPath, showHtml, updateHtml } from "./ui";

// Audit readiness: what an auditor will ask about first, for a Foundry project. A report in a webview, a summary in
// the sidebar, and scope.txt on request.

const GRANT_PATH = "/audit-grants";
const COVERAGE_COMMAND = "forgeDefender.coverage.run";

export function register(ctx: Ctx): void {
  registerOpenLocation(ctx);
  const state = ctx.extension.workspaceState;
  const runKey = (root: string) => `forgeDefender.security.lastRun:${root}`;

  function coverageOf(p: FoundryProject): Lcov | undefined {
    const last = ctx.lastCoverage.get(p.root);
    if (last) return last;
    // A report the developer made in a terminal counts too.
    try {
      return parseLcov(fs.readFileSync(path.join(p.root, "lcov.info"), "utf8"));
    } catch {
      return undefined;
    }
  }

  function report(p: FoundryProject): ReadinessReport {
    const src = path.join(p.root, p.config.src);
    const files = walk(src, [".sol"]).map((f) => ({ rel: relPath(p.root, f), text: fs.readFileSync(f, "utf8") }));
    return buildReport({
      project: p.name,
      files,
      lcov: coverageOf(p),
      tests: state.get<TestCounts>(runKey(p.root)),
      today: new Date(),
      grantUrl: siteLink(GRANT_PATH, "audit-readiness"),
      estimateUrl: links.auditEstimate(),
    });
  }

  async function hasCoverageCommand() {
    return (await vscode.commands.getCommands(true)).includes(COVERAGE_COMMAND);
  }

  async function html(p: FoundryProject, r: ReadinessReport) {
    const runCoverage = !r.coverage && (await hasCoverageCommand()) ? commandLink("forgeDefender.security.readinessCoverage", [p.root]) : undefined;
    return (csp: string) =>
      readinessHtml(r, { open: (file, line) => openLink(p.root, file, line) }, { writeScope: commandLink("forgeDefender.security.writeScope", [p.root]), runCoverage }, csp);
  }

  async function projectFor(root?: unknown): Promise<FoundryProject | undefined> {
    if (typeof root === "string") return (await ctx.foundryProjects()).find((p) => p.root === root);
    return ctx.pickFoundryProject();
  }

  async function show(p: FoundryProject): Promise<ReadinessReport> {
    const r = report(p);
    showHtml(`readiness:${p.root}`, `Audit readiness: ${p.name}`, await html(p, r));
    return r;
  }

  async function refreshOpen(p: FoundryProject) {
    const r = report(p);
    updateHtml(`readiness:${p.root}`, await html(p, r));
  }

  // Sidebar summary.
  type Node = { label: string; description?: string; tooltip?: string; icon?: string; command?: vscode.Command; children?: Node[] };
  const changed = new vscode.EventEmitter<void>();
  const summary = (p: FoundryProject): Node[] => {
    const r = report(p);
    const c = r.coverage;
    const open = { title: "Open report", command: "forgeDefender.security.auditReadiness", arguments: [p.root] };
    const n = (label: string, description: string, icon: string, tooltip?: string): Node => ({ label, description, icon, tooltip, command: open });
    return [
      n("Scope", `${r.nsloc} nSLOC in ${r.scope.length} ${r.scope.length === 1 ? "file" : "files"}`, "file-code", r.scope.map((f) => `${f.file}: ${f.nsloc}`).join("\n")),
      n("Coverage", c ? `lines ${coveragePercent(c.lines)}, branches ${coveragePercent(c.branches)}` : "not run yet", "shield"),
      n("Never run by tests", c ? String(r.unexecuted.length) : "needs coverage", "debug-step-over"),
      n("Without NatSpec", String(r.missingNatspec.length), "book"),
      n("Floating pragmas", String(r.floatingPragmas.length), "versions"),
      n("TODO / FIXME", String(r.todos.length), "checklist"),
      n("Last test run", r.tests ? `${r.tests.passed} passed, ${r.tests.failed} failed` : "none yet", r.tests?.failed ? "error" : "beaker"),
    ];
  };
  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    async getChildren(node) {
      if (node) return node.children ?? [];
      const projects = await ctx.foundryProjects();
      if (projects.length === 1) return summary(projects[0]);
      return projects.map((p) => ({ label: p.name, icon: "folder", children: summary(p) }));
    },
    getTreeItem(node) {
      const item = new vscode.TreeItem(node.label, node.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.command = node.command;
      if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    },
  };
  ctx.subscriptions.push(changed, vscode.window.createTreeView("forgeDefender.security.readiness", { treeDataProvider: provider }));

  let timer: NodeJS.Timeout | undefined;
  const refresh = (p?: FoundryProject) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      changed.fire();
      for (const proj of p ? [p] : await ctx.foundryProjects()) await refreshOpen(proj).catch(() => undefined);
    }, 500);
  };

  ctx.subscriptions.push(
    { dispose: () => timer && clearTimeout(timer) },
    vscode.commands.registerCommand("forgeDefender.security.auditReadiness", async (root?: unknown) => {
      const p = await projectFor(root);
      if (!p) {
        if (root === undefined) void vscode.window.showInformationMessage("No Foundry project in this workspace.");
        return undefined;
      }
      return show(p);
    }),
    vscode.commands.registerCommand("forgeDefender.security.writeScope", async (root?: unknown) => {
      const p = await projectFor(root);
      if (!p) return undefined;
      const file = path.join(p.root, "scope.txt");
      fs.writeFileSync(file, scopeText(report(p)));
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.One });
      return file;
    }),
    vscode.commands.registerCommand("forgeDefender.security.readinessCoverage", async (root?: unknown) => {
      const p = await projectFor(root);
      if (!p) return;
      if (!(await hasCoverageCommand())) {
        void vscode.window.showInformationMessage("Run `forge coverage --report lcov` in the project, then open the report again.");
        return;
      }
      await vscode.commands.executeCommand(COVERAGE_COMMAND, p.root);
      refresh(p);
    }),
    vscode.commands.registerCommand("forgeDefender.security.refreshReadiness", () => refresh()),
    ctx.onDidRunFoundryTests(async (e) => {
      const all = e.suites.flatMap((s) => s.tests);
      const counts: TestCounts = {
        passed: all.filter((t) => t.status === "passed").length,
        failed: all.filter((t) => t.status === "failed").length,
        skipped: all.filter((t) => t.status === "skipped").length,
        at: new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) + (e.complete ? "" : ", filtered run"),
      };
      await state.update(runKey(e.project.root), counts);
      refresh(e.project);
    }),
    ctx.onDidCoverage((e) => refresh(e.project)),
    ctx.onDidChangeProjects(() => refresh()),
    vscode.workspace.onDidSaveTextDocument((d) => d.uri.fsPath.endsWith(".sol") && refresh()),
  );
}
