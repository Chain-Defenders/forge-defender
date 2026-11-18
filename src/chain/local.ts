import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { tool, setting } from "../core/tools";
import { anvilAccounts, chainInfo, expandEnv, redactUrl } from "./chains";
import { evmStatus, EvmStatus, rpc, solanaHealth } from "./rpc";
import { runInTerminal } from "./terminal";

// The Local chain view: Anvil (plain or forking a network) and, for Anchor workspaces, solana-test-validator. Both run
// in terminals so their output stays visible; the view polls their RPC ports for status. A node someone started
// elsewhere on the same port is detected and shown, but not stopped from here.

const SOLANA_PORT = 8899;
const POLL_MS = 3000;

type Node =
  | { t: "status"; label: string; description?: string; tooltip?: string; icon: string; color?: string; context?: string }
  | { t: "accounts" }
  | { t: "account"; address: string; index: number };

export function register(ctx: Ctx): void {
  const view = new LocalChainView(ctx);
  const tree = vscode.window.createTreeView("forgeDefender.chain", { treeDataProvider: view });
  view.watch(tree);
  ctx.api.set("localChain", {
    snapshot: async () => {
      await view.poll();
      return view.snapshot();
    },
  });
  ctx.subscriptions.push(
    tree,
    view,
    vscode.commands.registerCommand("forgeDefender.chain.start", () => view.startAnvil()),
    vscode.commands.registerCommand("forgeDefender.chain.startFork", () => view.startFork()),
    vscode.commands.registerCommand("forgeDefender.chain.stop", () => view.stopAnvil()),
    vscode.commands.registerCommand("forgeDefender.chain.reset", () => view.reset()),
    vscode.commands.registerCommand("forgeDefender.chain.refresh", () => view.poll()),
    vscode.commands.registerCommand("forgeDefender.chain.copyAddress", async (a: Node | string) => {
      const address = typeof a === "string" ? a : a.t === "account" ? a.address : undefined;
      if (!address) return;
      await vscode.env.clipboard.writeText(address);
      vscode.window.setStatusBarMessage(`Copied ${address}`, 3000);
    }),
    vscode.commands.registerCommand("forgeDefender.chain.startSolana", () => view.startSolana()),
    vscode.commands.registerCommand("forgeDefender.chain.stopSolana", () => view.stopSolana()),
    vscode.window.onDidCloseTerminal((t) => view.terminalClosed(t)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("forgeDefender.chain")) void view.poll();
    }),
    ctx.onDidChangeProjects(() => void view.poll()),
  );
  void view.poll();
}

export function anvilPort(): number {
  const p = setting<number>("chain.port", 8545);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 8545;
}

class LocalChainView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private anvil?: { terminal: vscode.Terminal; fork?: string };
  private solana?: vscode.Terminal;
  private evm?: EvmStatus;
  private sol?: "ok" | "starting";
  private hasAnchor = false;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;

  constructor(private readonly ctx: Ctx) {}

  watch(tree: vscode.TreeView<Node>) {
    const update = () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (tree.visible) {
        void this.poll();
        this.timer = setInterval(() => void this.poll(), POLL_MS);
      }
    };
    this.ctx.subscriptions.push(tree.onDidChangeVisibility(update));
    update();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }

  poll(): Promise<void> {
    this.polling ??= this.doPoll().finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async doPoll() {
    const port = anvilPort();
    this.hasAnchor = (await this.ctx.anchorProjects()).length > 0;
    const [evm, sol] = await Promise.all([evmStatus(port), this.hasAnchor || this.solana ? solanaHealth(SOLANA_PORT) : Promise.resolve(undefined)]);
    const before = JSON.stringify([this.evm, this.sol]);
    this.evm = evm;
    this.sol = sol;
    void vscode.commands.executeCommand("setContext", "forgeDefender.chain.running", Boolean(evm));
    void vscode.commands.executeCommand("setContext", "forgeDefender.chain.ours", Boolean(this.anvil));
    void vscode.commands.executeCommand("setContext", "forgeDefender.chain.solana", this.hasAnchor);
    void vscode.commands.executeCommand("setContext", "forgeDefender.chain.solanaRunning", Boolean(sol));
    if (before !== JSON.stringify([this.evm, this.sol])) this.changed.fire();
  }

  snapshot() {
    return {
      port: anvilPort(),
      running: this.evm,
      startedHere: Boolean(this.anvil),
      fork: this.anvil?.fork,
      solana: this.sol,
      accounts: anvilAccounts,
      labels: this.getChildren().map((n) => (n.t === "status" ? n.label : n.t)),
    };
  }

  terminalClosed(t: vscode.Terminal) {
    if (this.anvil?.terminal === t) this.anvil = undefined;
    if (this.solana === t) this.solana = undefined;
    void this.poll().then(() => this.changed.fire());
  }

  private async cwd(): Promise<string | undefined> {
    const p = await this.ctx.pickFoundryProject();
    return p?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async busy(port: number): Promise<boolean> {
    const s = await evmStatus(port);
    if (!s) return false;
    void vscode.window.showInformationMessage(
      `A node is already running on port ${port} (${chainInfo(s.chainId).name}, chain ${s.chainId}). Stop it first, or set another port in forgeDefender.chain.port.`,
    );
    await this.poll();
    return true;
  }

  async startAnvil(): Promise<void> {
    const port = anvilPort();
    if (await this.busy(port)) return;
    const cwd = await this.cwd();
    if (!cwd) return;
    const terminal = runInTerminal({ name: "Anvil", cwd, args: [tool("anvil"), "--port", String(port)] });
    this.anvil = { terminal };
    this.ctx.log.info(`Local chain: starting Anvil on port ${port}`);
    await this.waitFor(() => Boolean(this.evm));
  }

  async startFork(): Promise<void> {
    const port = anvilPort();
    if (await this.busy(port)) return;
    const project = await this.ctx.pickFoundryProject();
    const cwd = project?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const endpoints = Object.entries(project?.config.rpc_endpoints ?? {});
    type Pick = vscode.QuickPickItem & { url?: string };
    const items: Pick[] = endpoints.map(([name, url]) => ({ label: name, description: redactUrl(expandEnv(url, process.env).value || url), url }));
    items.push({ label: "Enter a URL…", alwaysShow: true });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Network to fork (from rpc_endpoints in foundry.toml)" });
    if (!pick) return;
    let url = pick.url;
    let label = pick.label;
    if (url) {
      const { value, missing } = expandEnv(url, process.env);
      if (missing.length) {
        void vscode.window.showErrorMessage(
          `The ${pick.label} endpoint needs ${missing.join(", ")}, which VS Code's environment does not have. Set it and restart VS Code, or enter the URL.`,
        );
        return;
      }
      url = value;
    } else {
      url = await vscode.window.showInputBox({
        prompt: "RPC URL of the network to fork",
        placeHolder: "https://…",
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/^(https?|wss?):\/\/\S+$/.test(v.trim()) ? undefined : "An http(s) or ws(s) URL"),
      });
      if (!url) return;
      url = url.trim();
      label = redactUrl(url);
    }
    // The URL goes in an environment variable: provider URLs carry an API key, which must not show on the command line.
    const terminal = runInTerminal({
      name: `Anvil fork: ${label}`,
      cwd,
      args: [tool("anvil"), "--port", String(port), "--fork-url", { env: "FORGE_DEFENDER_FORK_URL" }],
      env: { FORGE_DEFENDER_FORK_URL: url },
    });
    this.anvil = { terminal, fork: label };
    this.ctx.log.info(`Local chain: starting an Anvil fork of ${label} on port ${port}`);
    await this.waitFor(() => Boolean(this.evm), 60_000);
  }

  async stopAnvil(): Promise<void> {
    if (!this.anvil) {
      if (this.evm) void vscode.window.showInformationMessage(`The node on port ${anvilPort()} was not started from VS Code. Stop it where it runs.`);
      return;
    }
    this.anvil.terminal.dispose();
    this.anvil = undefined;
    await this.waitFor(() => !this.evm);
  }

  async reset(): Promise<void> {
    if (!this.evm) return;
    try {
      await rpc(anvilPort(), "anvil_reset", []);
      this.ctx.log.info("Local chain: reset");
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not reset the chain: ${e instanceof Error ? e.message : e}. Only Anvil supports anvil_reset.`);
    }
    await this.poll();
    this.changed.fire();
  }

  async startSolana(): Promise<void> {
    if (await solanaHealth(SOLANA_PORT)) {
      void vscode.window.showInformationMessage(`A Solana validator is already running on port ${SOLANA_PORT}.`);
      return;
    }
    const anchors = await this.ctx.anchorProjects();
    const cwd = anchors[0]?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    // The ledger goes where `anchor test` keeps its own, so it is ignored like the rest of .anchor/.
    this.solana = runInTerminal({ name: "Solana test validator", cwd, args: [tool("solana-test-validator"), "--ledger", ".anchor/test-ledger"] });
    await this.waitFor(() => Boolean(this.sol), 60_000);
  }

  async stopSolana(): Promise<void> {
    if (!this.solana) {
      if (this.sol) void vscode.window.showInformationMessage("The Solana validator was not started from VS Code. Stop it where it runs.");
      return;
    }
    this.solana.dispose();
    this.solana = undefined;
    await this.waitFor(() => !this.sol);
  }

  private async waitFor(done: () => boolean, ms = 20_000) {
    const until = Date.now() + ms;
    for (;;) {
      await this.poll();
      if (done() || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.changed.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.t) {
      case "status": {
        const item = new vscode.TreeItem(n.label);
        item.description = n.description;
        item.tooltip = n.tooltip;
        item.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
        item.contextValue = n.context;
        return item;
      }
      case "accounts": {
        const item = new vscode.TreeItem("Test accounts", vscode.TreeItemCollapsibleState.Collapsed);
        item.description = "Anvil's public dev accounts";
        item.tooltip =
          "Anvil's default accounts come from a published test mnemonic: anyone can sign for them. Use them on a local chain only, never on a real network.";
        item.iconPath = new vscode.ThemeIcon("account");
        return item;
      }
      case "account": {
        const item = new vscode.TreeItem(n.address);
        item.description = `(${n.index})`;
        item.tooltip = "Click to copy the address";
        item.iconPath = new vscode.ThemeIcon("copy");
        item.contextValue = "chainAccount";
        item.command = { command: "forgeDefender.chain.copyAddress", title: "Copy address", arguments: [n.address] };
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    if (n?.t === "accounts") return anvilAccounts.map((address, index) => ({ t: "account", address, index }));
    if (n) return [];
    const port = anvilPort();
    const out: Node[] = [];
    if (this.evm) {
      const info = chainInfo(this.evm.chainId);
      out.push({
        t: "status",
        label: this.anvil?.fork ? `Fork of ${this.anvil.fork}` : this.anvil ? "Anvil running" : "Node running",
        description: `port ${port}, ${info.name} (${this.evm.chainId}), block ${this.evm.block}`,
        tooltip: this.anvil ? "Started from VS Code. Stop closes its terminal." : "Not started from VS Code: stop it where it runs.",
        icon: "vm-running",
        color: "testing.iconPassed",
        context: this.anvil ? "chainNode.ours" : "chainNode",
      });
    } else {
      out.push({
        t: "status",
        label: "Anvil not running",
        description: `port ${port}`,
        tooltip: "Start a local chain, or fork a network from foundry.toml's rpc_endpoints.",
        icon: "vm-outline",
      });
    }
    out.push({ t: "accounts" });
    if (this.hasAnchor || this.solana) {
      out.push(
        this.sol
          ? {
              t: "status",
              label: this.sol === "ok" ? "Solana validator running" : "Solana validator starting",
              description: `port ${SOLANA_PORT}`,
              icon: "vm-running",
              color: this.sol === "ok" ? "testing.iconPassed" : undefined,
              context: this.solana ? "solanaNode.ours" : "solanaNode",
            }
          : { t: "status", label: "Solana validator not running", description: `port ${SOLANA_PORT}`, icon: "vm-outline", context: "solanaNode.stopped" },
      );
    }
    return out;
  }
}
