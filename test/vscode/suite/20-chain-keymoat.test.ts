import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, foundryRoot } from "./helpers";

// Uses the keymoat build next to this repository when there is one (it has `doctor --json`), and the installed one
// for the text fallback. Skipped where keymoat is not available.

const fresh = path.resolve(__dirname, "../../../../../keymoat/keymoat");
const installed = "/usr/local/bin/keymoat";

type Snapshot = {
  state: string;
  legacy?: boolean;
  sandbox?: { ok: boolean; detail: string };
  tools?: { name: string; through: boolean }[];
  editorSandboxed?: boolean;
  keys?: { file: string; line?: number; name?: string }[];
  blocked?: unknown[];
  labels?: string[];
};

async function snapshotWith(keymoat: string): Promise<Snapshot> {
  await vscode.workspace.getConfiguration("forgeDefender.paths").update("keymoat", keymoat, vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("forgeDefender.keymoat.refresh");
  const api = (await activate()).api.get("keymoat") as { snapshot(): Promise<Snapshot> };
  return api.snapshot();
}

suite("Chain keymoat panel", () => {
  const env = path.join(foundryRoot, ".env");

  suiteSetup(async () => {
    await activate();
  });

  suiteTeardown(async () => {
    fs.rmSync(env, { force: true });
    await vscode.workspace.getConfiguration("forgeDefender.paths").update("keymoat", undefined, vscode.ConfigurationTarget.Global);
  });

  test("not installed: one explaining item", async () => {
    const s = await snapshotWith("/nonexistent/keymoat");
    assert.strictEqual(s.state, "missing");
  });

  test("doctor --json: sandbox, tools from VS Code's environment, plain keys at their line", async function () {
    if (!fs.existsSync(fresh)) this.skip();
    // A random key, made for this test only: keymoat skips the well-known public test keys.
    fs.writeFileSync(env, `RPC=http://127.0.0.1:8545\nPRIVATE_KEY=0x${crypto.randomBytes(32).toString("hex")}\n`);
    const s = await snapshotWith(fresh);
    assert.strictEqual(s.state, "ready");
    assert.strictEqual(s.legacy, false);
    assert.strictEqual(typeof s.sandbox?.ok, "boolean");
    assert.ok(s.tools?.some((t) => t.name === "forge"), JSON.stringify(s.tools));
    assert.strictEqual(typeof s.editorSandboxed, "boolean");
    const key = s.keys?.find((k) => k.file === fs.realpathSync(env) || k.file === env);
    assert.ok(key, JSON.stringify(s.keys));
    assert.strictEqual(key.line, 2);
    assert.strictEqual(key.name, "PRIVATE_KEY");
    assert.deepStrictEqual(s.blocked, []);
    assert.ok(s.labels?.some((l) => /^Editor runs are (not )?sandboxed$/.test(l)), JSON.stringify(s.labels));
    // The snapshot never carries a key's value.
    assert.ok(!JSON.stringify(s).includes(fs.readFileSync(env, "utf8").split("0x")[2]));
  });

  test("an older keymoat without doctor --json: read from its text", async function () {
    if (!fs.existsSync(installed)) this.skip();
    const s = await snapshotWith(installed);
    assert.strictEqual(s.state, "ready");
    assert.ok(s.tools?.length, JSON.stringify(s));
    if (s.legacy) assert.ok(s.labels?.includes("Update KeyMoat"));
  });
});
