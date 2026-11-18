import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, foundryRoot, waitFor } from "./helpers";

// Contract sizes and selectors against the Foundry fixture. Sizes builds the project, so the hovers after it read
// the compiled ABI.

const word = (n: number) => n.toString(16).padStart(64, "0");

suite("Chain sizes and selectors", () => {
  const counter = vscode.Uri.file(path.join(foundryRoot, "src/Counter.sol"));

  suiteSetup(async () => {
    await activate();
  });

  test("contract sizes are read and small contracts get no diagnostics", async () => {
    await vscode.commands.executeCommand("forgeDefender.sizes.check");
    const sizes = ((await activate()).api.get("sizes") as { snapshot(): Record<string, Record<string, { runtime: number; init: number }>> }).snapshot();
    const mine = Object.entries(sizes).find(([root]) => root === foundryRoot)?.[1];
    assert.ok(mine?.Counter, JSON.stringify(sizes));
    assert.ok(mine.Counter.runtime > 0 && mine.Counter.runtime < 24_576);
    assert.deepStrictEqual(
      vscode.languages.getDiagnostics(counter).filter((d) => d.code === "contract-size"),
      [],
    );
  });

  test("hover shows the signature and selector or topic", async () => {
    const doc = await vscode.workspace.openTextDocument(counter);
    const at = async (needle: string) => {
      const line = doc.getText().split("\n").findIndex((l) => l.includes(needle));
      const col = doc.lineAt(line).text.indexOf(needle.split(" ")[1]) + 1;
      const hovers = await waitFor(async () => {
        const h = (await vscode.commands.executeCommand("vscode.executeHoverProvider", counter, new vscode.Position(line, col))) as vscode.Hover[];
        const text = h.flatMap((x) => x.contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))).join("\n");
        return text.includes("Selector") || text.includes("Topic") ? text : undefined;
      }, `hover on ${needle}`, 30_000);
      return hovers;
    };
    const fn = await at("function setNumber");
    assert.ok(fn.includes("setNumber(uint256)") && fn.includes("0x3fb5c1cb"), fn);
    assert.ok(fn.includes("From the compiled ABI"), fn);
    const err = await at("error TooBig");
    assert.ok(err.includes("TooBig(uint256)") && err.includes("Selector"), err);
    const ev = await at("event Set");
    assert.ok(ev.includes("Set(uint256)") && ev.includes("Topic 0: `0x"), ev);
  });

  test("decodes calldata, custom errors, panics, and leaves unknown selectors offline", async () => {
    const decode = (hex: string) => vscode.commands.executeCommand("forgeDefender.selectors.decode", hex, { show: false, online: false }) as Thenable<string>;

    const call = await decode("0x3fb5c1cb" + word(42));
    assert.match(call, /Function `setNumber\(uint256\)`/);
    assert.match(call, /\| newNumber \| uint256 \| `42` \|/);

    const unknown = await decode("0xdeadbeef" + word(1234));
    assert.match(unknown, /not in the project's contracts/);
    assert.ok(!unknown.includes("Online lookup"));

    const known = (await vscode.commands.executeCommand("vscode.executeHoverProvider", vscode.Uri.file(path.join(foundryRoot, "src/Counter.sol")), new vscode.Position(8, 12))) as vscode.Hover[];
    const sel = known
      .flatMap((x) => x.contents.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : "")))
      .join("\n")
      .match(/Selector: `(0x[0-9a-f]{8})`/)?.[1];
    assert.ok(sel, "TooBig selector from hover");
    const err = await decode(sel + word(1234));
    assert.match(err, /Error `TooBig\(uint256\)`/);
    assert.match(err, /`1234`/);

    const panic = await decode("0x4e487b71" + word(0x12));
    assert.match(panic, /Panic 0x12: division or modulo by zero/);
  });
});
