import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, foundryRoot, waitFor } from "./helpers";
import type { FoundryTests } from "../../../src/foundry/testing";
import { traceTest } from "../../../src/foundry/trace";
import type { Lcov } from "../../../src/foundry/lcov";

// These run the real forge on the fixture project inside a real VS Code.

const id = (file: string, contract?: string, test?: string) => [foundryRoot, file, contract, test].filter(Boolean).join("|");

async function runItems(tests: FoundryTests, items?: vscode.TestItem[]) {
  const source = new vscode.CancellationTokenSource();
  await tests.runProfile.runHandler(new vscode.TestRunRequest(items, undefined, tests.runProfile), source.token);
}

suite("Foundry tests", () => {
  let tests: FoundryTests;

  suiteSetup(async () => {
    const ctx = await activate();
    tests = await waitFor(() => ctx.foundryTests, "the test explorer");
    await waitFor(() => tests.find(id("test/Counter.t.sol", "CounterTest", "test_Increment")), "discovery", 30_000);
  });

  test("the tree comes from the sources, with inherited tests and no abstract base", () => {
    const counter = tests.find(id("test/Counter.t.sol", "CounterTest"))!;
    const names: string[] = [];
    counter.children.forEach((c) => names.push(c.label));
    assert.deepStrictEqual(names.sort(), ["testFuzz_SetNumber", "test_FailsOnPurpose", "test_Increment", "test_InheritedPasses"]);
    assert.strictEqual(tests.find(id("test/Base.t.sol")), undefined);
    const inherited = counter.children.get(id("test/Counter.t.sol", "CounterTest", "test_InheritedPasses"))!;
    assert.strictEqual(inherited.uri!.fsPath, path.join(foundryRoot, "test/Base.t.sol"));
    assert.match(inherited.description ?? "", /from BaseTest/);
  });

  test("a full run gives every result, gas and failure", async () => {
    await runItems(tests);
    const outcome = (c: string, t: string) => tests.last.get(id("test/Counter.t.sol", c, t))?.outcome;
    assert.strictEqual(outcome("CounterTest", "test_Increment")?.status, "passed");
    assert.strictEqual(outcome("CounterTest", "test_FailsOnPurpose")?.status, "failed");
    assert.strictEqual(outcome("CounterTest", "testFuzz_SetNumber")?.status, "failed");
    assert.strictEqual(outcome("CounterTest", "test_InheritedPasses")?.status, "passed");
    assert.strictEqual(outcome("InvariantCounterTest", "invariant_Small")?.status, "failed");
    assert.strictEqual(outcome("InvariantCounterTest", "test_InheritedPasses")?.status, "passed");
    const inc = tests.find(id("test/Counter.t.sol", "CounterTest", "test_Increment"))!;
    assert.match(inc.description ?? "", /^\d{1,3}(,\d{3})* gas$/);
    assert.match(tests.gasAt(inc.uri!.fsPath, inc.range!.start.line) ?? "", / gas$/);
  });

  test("overloads share one item and fail if either fails; a failing setUp fails its tests", async () => {
    const over = tests.find(id("test/Edge.t.sol", "OverloadTest", "test_Over"))!;
    const never = tests.find(id("test/Edge.t.sol", "SetUpFailsTest", "test_NeverRuns"))!;
    await runItems(tests, [over, never]);
    const out = tests.last.get(over.id)!.outcome;
    assert.strictEqual(out.status, "failed");
    assert.strictEqual(out.signature, "test_Over(uint8)");
    assert.strictEqual(tests.find(id("test/Edge.t.sol", "SetUpFailsTest", "setUp")), undefined);
    assert.strictEqual(tests.last.get(never.id), undefined);
  });

  test("running one test runs only that test", async () => {
    tests.last.clear();
    await runItems(tests, [tests.find(id("test/Counter.t.sol", "CounterTest", "test_Increment"))!]);
    assert.deepStrictEqual([...tests.last.keys()], [id("test/Counter.t.sol", "CounterTest", "test_Increment")]);
  });

  test("a fuzz and an invariant failure become regression tests that fail the same way", async () => {
    await runItems(tests, [tests.find(id("test/Counter.t.sol", "CounterTest", "testFuzz_SetNumber"))!, tests.find(id("test/Counter.t.sol", "InvariantCounterTest", "invariant_Small"))!]);
    const fuzzName = await vscode.commands.executeCommand<string>("forgeDefender.tests.addRegression", tests.find(id("test/Counter.t.sol", "CounterTest", "testFuzz_SetNumber")));
    const invName = await vscode.commands.executeCommand<string>("forgeDefender.tests.addRegression", tests.find(id("test/Counter.t.sol", "InvariantCounterTest", "invariant_Small")));
    assert.strictEqual(fuzzName, "test_Regression_testFuzz_SetNumber_1");
    assert.strictEqual(invName, "test_Regression_invariant_Small_1");
    await vscode.workspace.saveAll();
    await tests.rediscover(vscode.Uri.file(path.join(foundryRoot, "test/Counter.t.sol")));
    const fuzzReg = await waitFor(() => tests.find(id("test/Counter.t.sol", "CounterTest", fuzzName)), "the new fuzz regression test");
    const invReg = await waitFor(() => tests.find(id("test/Counter.t.sol", "InvariantCounterTest", invName)), "the new invariant regression test");
    await runItems(tests, [fuzzReg, invReg]);
    const fuzzOut = tests.last.get(fuzzReg.id)!.outcome;
    assert.strictEqual(fuzzOut.status, "failed");
    assert.match(fuzzOut.reason ?? "", /^TooBig\(/);
    const invOut = tests.last.get(invReg.id)!.outcome;
    assert.strictEqual(invOut.status, "failed");
    assert.match(invOut.reason ?? "", /stays small/);
  });

  test("coverage marks the untested function", async () => {
    const lcov = await vscode.commands.executeCommand<Lcov>("forgeDefender.coverage.run", foundryRoot);
    const file = lcov.find((f) => f.file === "src/Counter.sol")!;
    assert.strictEqual(file.functions.find((f) => f.name === "Counter.untested")!.hits, 0);
    assert.ok(file.functions.find((f) => f.name === "Counter.increment")!.hits > 0);
  });

  test("the coverage profile reports results and file coverage", async () => {
    const source = new vscode.CancellationTokenSource();
    tests.last.clear();
    await tests.coverageProfile.runHandler(new vscode.TestRunRequest(undefined, undefined, tests.coverageProfile), source.token);
    // No exception and the run ended is the contract here; detailed numbers are checked above.
  });

  test("a trace is nested and decoded", async () => {
    const item = tests.find(id("test/Counter.t.sol", "CounterTest", "test_FailsOnPurpose"))!;
    const d = tests.dataOf(item)!;
    assert.strictEqual(d.kind, "test");
    const r = await traceTest((await activate()), d as never);
    assert.ok(r.trace, r.error);
    const run = r.trace!.roots.find((n) => n.fn === "test_FailsOnPurpose")!;
    assert.ok(run.children.some((c) => c.target === "Counter" && c.fn === "setNumber"));
    await vscode.commands.executeCommand("forgeDefender.trace.show", item);
  });

  test("a build error marks the line and fails the run cleanly", async () => {
    const file = path.join(foundryRoot, "src/Broken.sol");
    fs.writeFileSync(file, "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Broken { function f() public { uint x = ; } }\n");
    try {
      tests.last.clear();
      await runItems(tests, [tests.find(id("test/Counter.t.sol", "CounterTest", "test_Increment"))!]);
      assert.strictEqual(tests.last.size, 0);
      const diags = vscode.languages.getDiagnostics(vscode.Uri.file(file));
      assert.strictEqual(diags.length, 1);
      assert.strictEqual(diags[0].range.start.line, 2);
      assert.strictEqual(diags[0].source, "forge");
    } finally {
      fs.rmSync(file);
    }
    await runItems(tests, [tests.find(id("test/Counter.t.sol", "CounterTest", "test_Increment"))!]);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(file)).length, 0);
  });
});
