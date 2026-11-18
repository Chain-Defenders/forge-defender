import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import type { Project } from "../core/projects";
import data from "./data/advisories.json";
import { OPEN_LOCATION, registerOpenLocation } from "./ui";
import { anchorDeps, bySeverity, foundryDeps, matchAdvisories, type AdvisoryData, type Hit, type InstalledDep } from "./dependencies";

// Known advisories for the dependencies a project has installed, as diagnostics on the line that declares each
// dependency and in a Dependencies view. The data ships with the extension (scripts/update-advisories.mjs).

const advisoryData = data as AdvisoryData;
const SOURCE = "ForgeDefender advisories";

const severity = (s: string) =>
  s === "critical" || s === "high" ? vscode.DiagnosticSeverity.Error : s === "low" ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning;

export function hitMessage(h: Hit): string {
  const fix = h.fixed ? `Fixed in ${h.fixed}.` : "No fixed version yet.";
  return `${h.dep.name} ${h.dep.version}: ${h.advisory.title} (${h.advisory.severity}). ${fix}`;
}

interface ProjectDeps {
  project: Project;
  deps: InstalledDep[];
  hits: Hit[];
}

type Node =
  | { kind: "project"; p: ProjectDeps }
  | { kind: "dep"; p: ProjectDeps; dep: InstalledDep; hits: Hit[] }
  | { kind: "hit"; hit: Hit }
  | { kind: "empty"; text: string };

class DependencyTree implements vscode.TreeDataProvider<Node> {
  results: ProjectDeps[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  update(results: ProjectDeps[]) {
    this.results = results;
    this.changed.fire();
  }

  private depNodes(p: ProjectDeps): Node[] {
    // One row per package and version, even when several lines declare it.
    const seen = new Map<string, Node & { kind: "dep" }>();
    for (const dep of p.deps) {
      const key = `${dep.ecosystem}:${dep.name}@${dep.version}`;
      if (seen.has(key)) continue;
      const hits = p.hits.filter((h) => h.dep.name === dep.name && h.dep.version === dep.version && h.dep.ecosystem === dep.ecosystem);
      const unique = hits.filter((h, i) => hits.findIndex((x) => x.advisory.id === h.advisory.id) === i).sort(bySeverity);
      seen.set(key, { kind: "dep", p, dep, hits: unique });
    }
    return [...seen.values()].sort((a, b) => b.hits.length - a.hits.length || a.dep.name.localeCompare(b.dep.name));
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const withDeps = this.results.filter((r) => r.deps.length);
      if (!withDeps.length) return [{ kind: "empty", text: "No covered dependencies found" }];
      return withDeps.length === 1 ? this.depNodes(withDeps[0]) : withDeps.map((p) => ({ kind: "project", p }));
    }
    if (n.kind === "project") return this.depNodes(n.p);
    if (n.kind === "dep") return n.hits.map((hit) => ({ kind: "hit", hit }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case "empty":
        return new vscode.TreeItem(n.text);
      case "project": {
        const count = n.p.hits.length;
        const item = new vscode.TreeItem(n.p.project.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = count ? `${new Set(n.p.hits.map((h) => h.advisory.id)).size} advisories` : "no known advisories";
        return item;
      }
      case "dep": {
        const item = new vscode.TreeItem(n.dep.name, n.hits.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
        item.description = `${n.dep.version} · ${n.dep.via}`;
        item.iconPath = new vscode.ThemeIcon(
          n.hits.length ? "warning" : "pass",
          new vscode.ThemeColor(n.hits.length ? "problemsWarningIcon.foreground" : "testing.iconPassed"),
        );
        item.tooltip = n.hits.length ? `${n.hits.length} known ${n.hits.length === 1 ? "advisory" : "advisories"}` : "No known advisories";
        item.command = {
          title: "Open",
          command: OPEN_LOCATION,
          arguments: [n.p.project.root, n.dep.file, n.dep.line + 1],
        };
        return item;
      }
      case "hit": {
        const a = n.hit.advisory;
        const item = new vscode.TreeItem(a.title);
        item.description = `${a.severity} · ${n.hit.fixed ? `fixed in ${n.hit.fixed}` : "no fix yet"}`;
        item.tooltip = `${a.id}${a.cve ? ` / ${a.cve}` : ""}\nAffected: ${n.hit.range}\n${a.url}`;
        item.iconPath = new vscode.ThemeIcon(a.severity === "critical" || a.severity === "high" ? "error" : "warning");
        item.command = { title: "Open advisory", command: "vscode.open", arguments: [vscode.Uri.parse(a.url)] };
        return item;
      }
    }
  }
}

export function register(ctx: Ctx): void {
  registerOpenLocation(ctx);
  const diagnostics = vscode.languages.createDiagnosticCollection("forgeDefender.advisories");
  const tree = new DependencyTree();
  const view = vscode.window.createTreeView("forgeDefender.security.dependencies", { treeDataProvider: tree, showCollapseAll: true });
  view.description = `data of ${advisoryData.generated}`;
  ctx.subscriptions.push(diagnostics, view);

  async function scan(): Promise<Hit[]> {
    const projects = await ctx.projects();
    const results: ProjectDeps[] = [];
    for (const project of projects) {
      try {
        const deps = project.kind === "foundry" ? await foundryDeps(project.root, project.config.libs ?? ["lib"]) : anchorDeps(project.root);
        results.push({ project, deps, hits: matchAdvisories(deps, advisoryData) });
      } catch (e) {
        ctx.log.warn(`dependency check of ${project.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const r of results) {
      for (const h of r.hits) {
        const d = new vscode.Diagnostic(new vscode.Range(h.dep.line, 0, h.dep.line, 1000), hitMessage(h), severity(h.advisory.severity));
        d.source = SOURCE;
        d.code = { value: h.advisory.id, target: vscode.Uri.parse(h.advisory.url) };
        byFile.set(h.dep.file, [...(byFile.get(h.dep.file) ?? []), d]);
      }
    }
    diagnostics.clear();
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
    tree.update(results);
    const all = results.flatMap((r) => r.hits);
    const ids = new Set(all.map((h) => h.advisory.id)).size;
    view.badge = ids ? { value: ids, tooltip: `${ids} known ${ids === 1 ? "advisory" : "advisories"} in your dependencies` } : undefined;
    return all;
  }

  let timer: NodeJS.Timeout | undefined;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void scan().catch((e) => ctx.log.warn(`dependency check: ${e}`)), 1500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/{.gitmodules,package.json,Cargo.lock,Cargo.toml,foundry.toml}");
  for (const ev of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
    ev((uri) => {
      // node_modules has thousands of package.json files; only the covered packages' own ones matter.
      const p = uri.fsPath.split(path.sep).join("/");
      if (p.includes("/node_modules/") && !/\/node_modules\/(@openzeppelin\/[^/]+|solady|solmate)\/package\.json$/.test(p)) return;
      later();
    });
  }
  ctx.subscriptions.push(
    watcher,
    { dispose: () => timer && clearTimeout(timer) },
    ctx.onDidChangeProjects(later),
    vscode.commands.registerCommand("forgeDefender.security.checkDependencies", async (quiet?: boolean) => {
      const hits = await scan();
      if (quiet !== true) {
        const ids = new Set(hits.map((h) => h.advisory.id)).size;
        void vscode.window.showInformationMessage(
          ids ? `${ids} known ${ids === 1 ? "advisory affects" : "advisories affect"} your dependencies. See Problems.` : `No known advisories for your dependencies (data of ${advisoryData.generated}).`,
        );
      }
      return hits;
    }),
  );
  later();
}
