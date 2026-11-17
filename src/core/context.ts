import * as vscode from "vscode";
import { findProjects, Project, FoundryProject, AnchorProject } from "./projects";
import type { SuiteResult } from "../foundry/results";
import type { Lcov } from "../foundry/lcov";
import type { FoundryTests } from "../foundry/testing";

// What every feature gets: the log, the projects in the workspace, and the events other features publish.
// A feature is a module with `register(ctx)`; it adds its disposables to ctx.subscriptions.

export interface FoundryRunEvent {
  project: FoundryProject;
  suites: SuiteResult[];
  /** True when the run had no filter, so missing tests mean removed tests. */
  complete: boolean;
}

export interface CoverageEvent {
  project: FoundryProject;
  lcov: Lcov;
}

export class Ctx implements vscode.Disposable {
  readonly log: vscode.LogOutputChannel;
  readonly subscriptions: vscode.Disposable[] = [];

  private cached?: Promise<Project[]>;
  private readonly projectsChanged = new vscode.EventEmitter<Project[]>();
  readonly onDidChangeProjects = this.projectsChanged.event;

  private readonly foundryRun = new vscode.EventEmitter<FoundryRunEvent>();
  /** Fired after each `forge test` run, with its parsed results. */
  readonly onDidRunFoundryTests = this.foundryRun.event;

  private readonly coverage = new vscode.EventEmitter<CoverageEvent>();
  /** Fired after each coverage run. The last one per project is kept in `lastCoverage`. */
  readonly onDidCoverage = this.coverage.event;
  readonly lastCoverage = new Map<string, Lcov>();

  /** The Foundry test explorer, once registered. Exposed here (not as a module variable) so tests reach the same one. */
  foundryTests?: FoundryTests;

  /**
   * Feature objects other code (mostly the editor tests) needs to reach, by name. The editor tests load the
   * compiled sources while the editor runs the bundle, so a module-level variable is not shared between them.
   */
  readonly api = new Map<string, unknown>();

  constructor(readonly extension: vscode.ExtensionContext) {
    this.log = vscode.window.createOutputChannel("ForgeDefender", { log: true });
    this.subscriptions.push(this.log, this.projectsChanged, this.foundryRun, this.coverage);
    const watcher = vscode.workspace.createFileSystemWatcher("**/{foundry.toml,Anchor.toml}");
    const reset = () => {
      this.cached = undefined;
      void this.projects().then((p) => this.projectsChanged.fire(p));
    };
    watcher.onDidCreate(reset);
    watcher.onDidDelete(reset);
    watcher.onDidChange(reset);
    this.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(reset));
  }

  projects(): Promise<Project[]> {
    this.cached ??= findProjects().catch((e) => {
      this.log.error(`finding projects: ${e}`);
      return [];
    });
    return this.cached;
  }

  async foundryProjects(): Promise<FoundryProject[]> {
    return (await this.projects()).filter((p): p is FoundryProject => p.kind === "foundry");
  }

  async anchorProjects(): Promise<AnchorProject[]> {
    return (await this.projects()).filter((p): p is AnchorProject => p.kind === "anchor");
  }

  publishFoundryRun(e: FoundryRunEvent) {
    this.foundryRun.fire(e);
  }

  publishCoverage(e: CoverageEvent) {
    this.lastCoverage.set(e.project.root, e.lcov);
    this.coverage.fire(e);
  }

  /** Asks the user to pick a project when there are several; undefined when none or cancelled. */
  async pickFoundryProject(hint?: vscode.Uri): Promise<FoundryProject | undefined> {
    const all = await this.foundryProjects();
    const file = hint?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    if (file) {
      const owner = all.filter((p) => file.startsWith(p.root)).sort((a, b) => b.root.length - a.root.length)[0];
      if (owner) return owner;
    }
    if (all.length <= 1) return all[0];
    const pick = await vscode.window.showQuickPick(
      all.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.root), p })),
      { placeHolder: "Which Foundry project?" },
    );
    return pick?.p;
  }

  dispose() {
    for (const d of this.subscriptions.splice(0)) d.dispose();
  }
}
