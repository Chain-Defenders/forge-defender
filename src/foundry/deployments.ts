import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import type { FoundryProject } from "../core/projects";
import { findArtifact } from "../core/artifacts";
import { tool } from "../core/tools";
import { Deployment, readDeployments } from "../chain/broadcast";
import { addressUrl, chainInfo, txUrl } from "../chain/chains";
import { runInTerminal } from "../chain/terminal";

// The Deployments view: contracts created by `forge script --broadcast`, per chain, from each project's broadcast
// folder. Refreshed when forge writes a new run.

type Node =
  | { t: "project"; project: FoundryProject; deployments: Deployment[] }
  | { t: "chain"; project: FoundryProject; chainId: number; deployments: Deployment[] }
  | { t: "deployment"; project: FoundryProject; d: Deployment }
  | { t: "empty" };

export function register(ctx: Ctx): void {
  const view = new DeploymentsView(ctx);
  const tree = vscode.window.createTreeView("forgeDefender.deployments", { treeDataProvider: view });
  const watcher = vscode.workspace.createFileSystemWatcher("**/run-latest.json");
  let timer: NodeJS.Timeout | undefined;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void view.refresh(), 300);
  };
  watcher.onDidCreate(soon);
  watcher.onDidChange(soon);
  watcher.onDidDelete(soon);
  ctx.api.set("deployments", {
    snapshot: async () => {
      await view.refresh();
      return view.all.map((d) => ({ ...d, chainName: chainInfo(d.chainId).name }));
    },
  });
  ctx.subscriptions.push(
    tree,
    view,
    watcher,
    { dispose: () => timer && clearTimeout(timer) },
    vscode.commands.registerCommand("forgeDefender.deployments.refresh", () => view.refresh()),
    vscode.commands.registerCommand("forgeDefender.deployments.copyAddress", async (n: Node) => {
      if (n?.t !== "deployment") return;
      await vscode.env.clipboard.writeText(n.d.address);
      vscode.window.setStatusBarMessage(`Copied ${n.d.address}`, 3000);
    }),
    vscode.commands.registerCommand("forgeDefender.deployments.copyTx", async (n: Node) => {
      if (n?.t !== "deployment") return;
      await vscode.env.clipboard.writeText(n.d.txHash);
      vscode.window.setStatusBarMessage(`Copied ${n.d.txHash}`, 3000);
    }),
    vscode.commands.registerCommand("forgeDefender.deployments.openExplorer", (n: Node) => {
      if (n?.t !== "deployment") return;
      const url = addressUrl(n.d.chainId, n.d.address);
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      else void vscode.window.showInformationMessage(`No block explorer known for ${chainInfo(n.d.chainId).name}.`);
    }),
    vscode.commands.registerCommand("forgeDefender.deployments.verify", (n: Node) => {
      if (n?.t === "deployment") verify(ctx, n.project, n.d);
    }),
    ctx.onDidChangeProjects(() => void view.refresh()),
  );
  void view.refresh();
}

class DeploymentsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private byProject: { project: FoundryProject; deployments: Deployment[] }[] = [];
  all: Deployment[] = [];

  constructor(private readonly ctx: Ctx) {}

  dispose() {
    this.changed.dispose();
  }

  async refresh(): Promise<void> {
    const projects = await this.ctx.foundryProjects();
    this.byProject = projects.map((project) => ({
      project,
      deployments: readDeployments(path.resolve(project.root, project.config.broadcast), (file, e) => this.ctx.log.warn(`Deployments: could not read ${file}: ${e}`)),
    }));
    this.all = this.byProject.flatMap((p) => p.deployments);
    void vscode.commands.executeCommand("setContext", "forgeDefender.deployments.any", this.all.length > 0);
    this.changed.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.t) {
      case "empty": {
        const item = new vscode.TreeItem("No deployments yet");
        item.description = "forge script … --broadcast records them";
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "project": {
        const item = new vscode.TreeItem(n.project.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = vscode.workspace.asRelativePath(n.project.root);
        item.iconPath = new vscode.ThemeIcon("folder");
        return item;
      }
      case "chain": {
        const info = chainInfo(n.chainId);
        const item = new vscode.TreeItem(info.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `chain ${n.chainId}`;
        item.iconPath = new vscode.ThemeIcon(info.local ? "vm" : "globe");
        return item;
      }
      case "deployment": {
        const d = n.d;
        const item = new vscode.TreeItem(d.contractName);
        const when = d.time ? new Date(d.time).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
        item.description = `${short(d.address)}  ${d.script}${when ? `, ${when}` : ""}`;
        const md = new vscode.MarkdownString();
        // Names and hashes come from committed broadcast files, so they are added as plain text.
        md.appendText(`${d.contractName} on ${chainInfo(d.chainId).name} (${d.chainId})\n\n`);
        md.appendText(`Address: ${d.address}\n\nTransaction: ${d.txHash}\n\n`);
        md.appendText(`Script: ${d.script}${when ? `, ${when}` : ""}${d.kind === "additional" ? " (created by another contract)" : ""}`);
        const tx = txUrl(d.chainId, d.txHash);
        if (tx) md.appendMarkdown(`\n\n[Transaction on the explorer](${tx})`);
        item.tooltip = md;
        item.iconPath = new vscode.ThemeIcon("symbol-class");
        const explorer = Boolean(addressUrl(d.chainId, d.address));
        item.contextValue = ["deployment", explorer ? "explorer" : "", chainInfo(d.chainId).local ? "" : "verifiable"].filter(Boolean).join(".");
        item.command = { command: "forgeDefender.deployments.copyAddress", title: "Copy address", arguments: [n] };
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (!n) {
      const withAny = this.byProject.filter((p) => p.deployments.length);
      if (!withAny.length) return [{ t: "empty" }];
      if (this.byProject.length === 1) return this.chains(withAny[0].project, withAny[0].deployments);
      return withAny.map((p) => ({ t: "project", ...p }));
    }
    if (n.t === "project") return this.chains(n.project, n.deployments);
    if (n.t === "chain") return n.deployments.map((d) => ({ t: "deployment", project: n.project, d }));
    return [];
  }

  private chains(project: FoundryProject, deployments: Deployment[]): Node[] {
    const ids = [...new Set(deployments.map((d) => d.chainId))];
    return ids.map((chainId) => ({ t: "chain", project, chainId, deployments: deployments.filter((d) => d.chainId === chainId) }));
  }
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function verify(ctx: Ctx, project: FoundryProject, d: Deployment) {
  const artifact = findArtifact(project.root, d.contractName, undefined, project.config.out);
  if (!artifact?.source) {
    void vscode.window.showErrorMessage(`Cannot find ${d.contractName}'s source file in ${project.config.out}/. Build the project first.`);
    return;
  }
  ctx.log.info(`Deployments: verifying ${d.contractName} at ${d.address} on chain ${d.chainId}`);
  runInTerminal({
    name: `Verify ${d.contractName}`,
    cwd: project.root,
    args: [tool("forge"), "verify-contract", d.address, `${artifact.source}:${d.contractName}`, "--chain", String(d.chainId), "--watch"],
  });
}
