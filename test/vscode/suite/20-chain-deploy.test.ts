import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import { activate, foundryRoot, waitFor } from "./helpers";
import { freePort, startAnvil, stopAnvil } from "./20-chain-helpers";

// A real deployment of the fixture's script to an Anvil on a free port, signed by Anvil's unlocked test account
// (the same flags as the "Anvil test account" signer), then the Deployments view picking it up from broadcast/.

const anvil0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

suite("Chain deployments and deploy", () => {
  suiteSetup(async () => {
    await activate();
  });

  suiteTeardown(() => {
    fs.rmSync(path.join(foundryRoot, "broadcast"), { recursive: true, force: true });
  });

  test("CodeLens on run() in a script", async () => {
    const uri = vscode.Uri.file(path.join(foundryRoot, "script/Deploy.s.sol"));
    await vscode.workspace.openTextDocument(uri);
    const lenses = await waitFor(async () => {
      const l = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri)) as vscode.CodeLens[];
      const ours = l.filter((x) => x.command?.command.startsWith("forgeDefender.deploy."));
      return ours.length ? ours : undefined;
    }, "deploy lenses", 30_000);
    assert.deepStrictEqual(
      lenses.map((l) => [l.command?.title, l.range.start.line, l.command?.arguments?.[1]]),
      [
        ["Dry run", 13, "DeployScript"],
        ["Deploy…", 13, "DeployScript"],
      ],
    );
  });

  test("a broadcast deployment shows in the Deployments view", async () => {
    const port = await freePort();
    const anvil = await startAnvil(port);
    try {
      const r = spawnSync(
        "forge",
        ["script", "script/Deploy.s.sol:DeployScript", "--rpc-url", `http://127.0.0.1:${port}`, "--broadcast", "--unlocked", "--sender", anvil0],
        { cwd: foundryRoot, encoding: "utf8", timeout: 300_000 },
      );
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    } finally {
      await stopAnvil(anvil, port);
    }
    type D = { contractName: string; address: string; chainId: number; chainName: string; script: string; txHash: string };
    const list = await waitFor(async () => {
      const d = await ((await activate()).api.get("deployments") as { snapshot(): Promise<D[]> }).snapshot();
      return d.length ? d : undefined;
    }, "the deployment in the view", 30_000);
    assert.strictEqual(list[0].contractName, "Counter");
    assert.strictEqual(list[0].address, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    assert.strictEqual(list[0].chainId, 31337);
    assert.strictEqual(list[0].chainName, "Anvil (local)");
    assert.strictEqual(list[0].script, "Deploy.s.sol");
    assert.match(list[0].txHash, /^0x[0-9a-f]{64}$/);
  });
});
