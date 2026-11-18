import * as assert from "node:assert";
import * as vscode from "vscode";
import { activate, waitFor } from "./helpers";
import { freePort, rpc, startAnvil, stopAnvil } from "./20-chain-helpers";

type Snapshot = { port: number; running?: { chainId: number; block: number }; startedHere: boolean; accounts: string[]; labels: string[] };

const snapshot = async () => ((await activate()).api.get("localChain") as { snapshot(): Promise<Snapshot> }).snapshot();

suite("Chain local chain view", () => {
  let port = 0;

  suiteSetup(async () => {
    await activate();
    port = await freePort();
    await vscode.workspace.getConfiguration("forgeDefender.chain").update("port", port, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration("forgeDefender.chain").update("port", undefined, vscode.ConfigurationTarget.Global);
  });

  test("detects a node someone else started, resets it, and sees it stop", async () => {
    const before = await snapshot();
    assert.strictEqual(before.port, port);
    assert.strictEqual(before.running, undefined);
    assert.strictEqual(before.accounts.length, 10);

    const anvil = await startAnvil(port);
    try {
      await rpc(port, "evm_mine");
      const s = await snapshot();
      assert.deepStrictEqual(s.running, { chainId: 31337, block: 1 });
      assert.strictEqual(s.startedHere, false);
      assert.strictEqual(s.labels[0], "Node running");

      await vscode.commands.executeCommand("forgeDefender.chain.reset");
      assert.strictEqual((await snapshot()).running?.block, 0);
    } finally {
      await stopAnvil(anvil, port);
    }
    assert.strictEqual((await snapshot()).running, undefined);
  });

  test("starts Anvil in a terminal and stops it", async () => {
    await vscode.commands.executeCommand("forgeDefender.chain.start");
    const s = await waitFor(async () => {
      const x = await snapshot();
      return x.running ? x : undefined;
    }, "Anvil started from the view", 60_000);
    assert.strictEqual(s.startedHere, true);
    assert.strictEqual(s.running?.chainId, 31337);
    assert.ok(vscode.window.terminals.some((t) => t.name === "Anvil"));

    await vscode.commands.executeCommand("forgeDefender.chain.stop");
    await waitFor(async () => !(await snapshot()).running, "Anvil to stop", 20_000);
  });
});
