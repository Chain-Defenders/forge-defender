import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { exec } from "../core/exec";
import { FoundryProject, projectOf, walk } from "../core/projects";
import { parseSolidity } from "../core/solidity";
import { tool } from "../core/tools";
import { anvilAccounts, redactUrl } from "../chain/chains";
import { anvilPort } from "../chain/local";
import { evmStatus } from "../chain/rpc";
import { Arg } from "../chain/shell";
import { runInTerminal } from "../chain/terminal";

// Deploying from the editor. "Dry run" and "Deploy…" above `function run()` in a script, and a command for
// `anchor deploy`. Everything runs in a terminal: forge asks for the keystore password there, and keymoat (when
// installed) shows its confirmation there. Signers are Foundry keystores, Ledger or Trezor; never a raw private key.

interface Target {
  project: FoundryProject;
  /** Script path relative to the project root. */
  file: string;
  contract: string;
}

interface Network {
  /** Shown in the terminal name; never holds a URL's key. */
  label: string;
  rpc?: Arg;
  env?: Record<string, string>;
  local?: boolean;
}

export function register(ctx: Ctx): void {
  const lenses = new ScriptLenses(ctx);
  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file", pattern: "**/*.s.sol" }, lenses),
    vscode.commands.registerCommand("forgeDefender.deploy.dryRun", async (uri?: vscode.Uri, contract?: string) => {
      const t = await target(ctx, uri, contract);
      if (t) await dryRun(ctx, t);
    }),
    vscode.commands.registerCommand("forgeDefender.deploy.script", async (uri?: vscode.Uri, contract?: string) => {
      const t = await target(ctx, uri, contract);
      if (t) await deploy(ctx, t);
    }),
    vscode.commands.registerCommand("forgeDefender.deploy.anchor", () => anchorDeploy(ctx)),
  );
}

/** Contracts in a script file with a `run()` taking no arguments, and the line of that function. */
export function runFunctions(src: string): { contract: string; line: number }[] {
  return parseSolidity(src)
    .contracts.filter((c) => c.kind === "contract" && !c.abstract)
    .flatMap((c) => c.functions.filter((f) => f.name === "run" && f.params === "").map((f) => ({ contract: c.name, line: f.line })));
}

class ScriptLenses implements vscode.CodeLensProvider {
  constructor(private readonly ctx: Ctx) {}

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const project = projectOf(await this.ctx.foundryProjects(), doc.uri.fsPath);
    if (!project) return [];
    const scripts = path.resolve(project.root, project.config.script);
    if (!doc.uri.fsPath.startsWith(scripts + path.sep)) return [];
    return runFunctions(doc.getText()).flatMap(({ contract, line }) => {
      const range = new vscode.Range(line, 0, line, 0);
      return [
        new vscode.CodeLens(range, { title: "Dry run", command: "forgeDefender.deploy.dryRun", arguments: [doc.uri, contract], tooltip: `Simulate ${contract}.run() without broadcasting` }),
        new vscode.CodeLens(range, { title: "Deploy…", command: "forgeDefender.deploy.script", arguments: [doc.uri, contract], tooltip: `Broadcast ${contract}.run() to a network` }),
      ];
    });
  }
}

async function target(ctx: Ctx, uri?: vscode.Uri, contract?: string): Promise<Target | undefined> {
  if (uri && contract) {
    const project = projectOf(await ctx.foundryProjects(), uri.fsPath);
    if (project) return { project, file: path.relative(project.root, uri.fsPath).split(path.sep).join("/"), contract };
  }
  // From the command palette: the script open in the editor, or a pick from the project's scripts.
  const project = await ctx.pickFoundryProject(uri);
  if (!project) {
    void vscode.window.showInformationMessage("No Foundry project in this workspace.");
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  const files = active?.fileName.endsWith(".s.sol") && projectOf([project], active.fileName) ? [active.fileName] : walk(path.resolve(project.root, project.config.script), [".s.sol"]);
  const items = files.flatMap((f) => {
    let src: string;
    try {
      src = fs.readFileSync(f, "utf8");
    } catch {
      return [];
    }
    const rel = path.relative(project.root, f).split(path.sep).join("/");
    return runFunctions(src).map((r) => ({ label: r.contract, description: rel, t: { project, file: rel, contract: r.contract } }));
  });
  if (!items.length) {
    void vscode.window.showInformationMessage(`No script with a run() function in ${project.config.script}/.`);
    return undefined;
  }
  if (items.length === 1) return items[0].t;
  return (await vscode.window.showQuickPick(items, { placeHolder: "Which script?" }))?.t;
}

async function pickNetwork(project: FoundryProject, allowNone: boolean): Promise<Network | undefined> {
  type Item = vscode.QuickPickItem & { n?: Network; enter?: boolean };
  const port = anvilPort();
  const items: Item[] = [];
  if (allowNone) items.push({ label: "No network", description: "simulate in memory", n: { label: "no network" } });
  items.push({ label: "Local Anvil", description: `127.0.0.1:${port}`, n: { label: "local Anvil", rpc: `http://127.0.0.1:${port}`, local: true } });
  for (const [alias, url] of Object.entries(project.config.rpc_endpoints ?? {})) {
    // forge resolves the alias (and any ${VAR} in it) itself, so the URL never appears on the command line.
    items.push({ label: alias, description: `rpc_endpoints: ${redactUrl(url)}`, n: { label: alias, rpc: alias } });
  }
  items.push({ label: "Enter a URL…", enter: true, alwaysShow: true });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Network" });
  if (!pick) return undefined;
  if (pick.n?.local) {
    const s = await evmStatus(port);
    if (!s) {
      const start = await vscode.window.showWarningMessage(`Nothing is running on port ${port}.`, "Start Anvil");
      if (start !== "Start Anvil") return undefined;
      await vscode.commands.executeCommand("forgeDefender.chain.start");
      if (!(await evmStatus(port))) return undefined;
    }
  }
  if (!pick.enter) return pick.n;
  const url = await vscode.window.showInputBox({
    prompt: "RPC URL",
    placeHolder: "https://…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (/^(https?|wss?):\/\/\S+$/.test(v.trim()) ? undefined : "An http(s) or ws(s) URL"),
  });
  if (!url) return undefined;
  return { label: redactUrl(url.trim()), rpc: { env: "FORGE_DEFENDER_RPC_URL" }, env: { FORGE_DEFENDER_RPC_URL: url.trim() } };
}

/** Foundry keystores, from `cast wallet list` ("name (Local)" per line). */
async function keystores(cwd: string): Promise<string[]> {
  const r = await exec(tool("cast"), ["wallet", "list"], { cwd, timeoutMs: 15_000 });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.match(/^(\S+) \(Local\)$/)?.[1])
    .filter((n): n is string => Boolean(n));
}

async function pickSigner(network: Network, cwd: string): Promise<string[] | undefined> {
  type Item = vscode.QuickPickItem & { args?: string[] };
  const items: Item[] = (await keystores(cwd)).map((name) => ({ label: name, description: "Foundry keystore", args: ["--account", name] }));
  items.push({ label: "Ledger", description: "hardware wallet", args: ["--ledger"] }, { label: "Trezor", description: "hardware wallet", args: ["--trezor"] });
  if (network.local) {
    items.push({
      label: "Anvil test account 0",
      description: anvilAccounts[0],
      detail: "Unlocked on Anvil, so no key is needed. Local chain only.",
      args: ["--unlocked", "--sender", anvilAccounts[0]],
    });
  }
  if (items.length === 2) {
    items.push({ label: "No keystore found", description: "create one with `cast wallet import NAME --interactive`", kind: vscode.QuickPickItemKind.Separator });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Signer" });
  return pick?.args;
}

async function dryRun(ctx: Ctx, t: Target) {
  const network = await pickNetwork(t.project, true);
  if (!network) return;
  const args: Arg[] = [tool("forge"), "script", `${t.file}:${t.contract}`];
  if (network.rpc) args.push("--rpc-url", network.rpc);
  ctx.log.info(`Deploy: dry run of ${t.contract} on ${network.label}`);
  runInTerminal({ name: `Dry run ${t.contract}`, cwd: t.project.root, args, env: network.env });
}

async function deploy(ctx: Ctx, t: Target) {
  const network = await pickNetwork(t.project, false);
  if (!network?.rpc) return;
  const signer = await pickSigner(network, t.project.root);
  if (!signer) return;
  const args: Arg[] = [tool("forge"), "script", `${t.file}:${t.contract}`, "--rpc-url", network.rpc, "--broadcast", ...signer];
  if (!network.local) {
    const v = await vscode.window.showQuickPick(
      [
        { label: "Deploy and verify", verify: true, description: "needs an explorer API key in foundry.toml or ETHERSCAN_API_KEY" },
        { label: "Deploy only", verify: false },
      ],
      { placeHolder: "Verify the source on the block explorer?" },
    );
    if (!v) return;
    if (v.verify) args.push("--verify");
  }
  ctx.log.info(`Deploy: ${t.contract} to ${network.label}`);
  runInTerminal({ name: `Deploy ${t.contract} to ${network.label}`, cwd: t.project.root, args, env: network.env });
}

async function anchorDeploy(ctx: Ctx) {
  const anchors = await ctx.anchorProjects();
  if (!anchors.length) {
    void vscode.window.showInformationMessage("No Anchor project in this workspace.");
    return;
  }
  const project =
    anchors.length === 1
      ? anchors[0]
      : (await vscode.window.showQuickPick(anchors.map((p) => ({ label: p.name, description: vscode.workspace.asRelativePath(p.root), p })), { placeHolder: "Which Anchor project?" }))?.p;
  if (!project) return;
  const cluster = await vscode.window.showQuickPick(
    [
      { label: "localnet", description: "solana-test-validator on this machine" },
      { label: "devnet", description: "Solana devnet" },
      { label: "testnet", description: "Solana testnet" },
      { label: "mainnet", description: "Solana mainnet-beta: real funds" },
    ],
    { placeHolder: "Cluster (the wallet is the one in Anchor.toml)" },
  );
  if (!cluster) return;
  if (cluster.label === "mainnet") {
    const ok = await vscode.window.showWarningMessage(`Deploy ${project.name} to Solana mainnet?`, { modal: true, detail: "This spends real SOL from the wallet in Anchor.toml." }, "Deploy");
    if (ok !== "Deploy") return;
  }
  ctx.log.info(`Deploy: anchor deploy of ${project.name} to ${cluster.label}`);
  runInTerminal({ name: `anchor deploy (${cluster.label})`, cwd: project.root, args: [tool("anchor"), "deploy", "--provider.cluster", cluster.label] });
}
