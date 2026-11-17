import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseTestJson, parseDuration } from "../../src/foundry/results";
import { parseLcov, summarize } from "../../src/foundry/lcov";
import { parseSnapshot, gasChange, describeGas } from "../../src/foundry/gas";
import { parseCompilerMessages, parseTextResults } from "../../src/foundry/text";
import { parseTraces } from "../../src/foundry/traceParse";

// All inputs are real forge 1.9 output from the fixture project (test/unit/data).
const data = (f: string) => fs.readFileSync(path.join(__dirname, "../../../test/unit/data", f), "utf8");

suite("forge test --json", () => {
  const suites = parseTestJson(data("forge-test.json"));
  const byName = (contract: string, name: string) => suites.find((s) => s.contract === contract)!.tests.find((t) => t.name === name)!;

  test("reads every suite and test", () => {
    assert.deepStrictEqual(suites.map((s) => `${s.file}:${s.contract}`).sort(), ["test/Counter.t.sol:CounterTest", "test/Counter.t.sol:InvariantCounterTest"]);
    assert.strictEqual(suites.flatMap((s) => s.tests).length, 6);
  });

  test("passing unit test has gas and duration", () => {
    const t = byName("CounterTest", "test_Increment");
    assert.strictEqual(t.status, "passed");
    assert.strictEqual(t.kind, "unit");
    assert.ok(t.gas! > 1000);
    assert.ok(t.durationMs! > 0 && t.durationMs! < 10_000);
  });

  test("failing test keeps the reason", () => {
    const t = byName("CounterTest", "test_FailsOnPurpose");
    assert.strictEqual(t.status, "failed");
    assert.strictEqual(t.reason, "number should be six");
  });

  test("fuzz failure has a single counterexample and no gas", () => {
    const t = byName("CounterTest", "testFuzz_SetNumber");
    assert.strictEqual(t.kind, "fuzz");
    assert.strictEqual(t.signature, "testFuzz_SetNumber(uint256)");
    assert.strictEqual(t.counterexample?.kind, "single");
    assert.match((t.counterexample as { calldata: string }).calldata, /^0x5c7f60d7/);
    assert.strictEqual(t.gas, undefined);
  });

  test("invariant failure has the call sequence", () => {
    const t = byName("InvariantCounterTest", "invariant_Small");
    assert.strictEqual(t.kind, "invariant");
    assert.strictEqual(t.status, "failed");
    assert.ok(t.reason && t.reason.includes("stays small"));
    assert.strictEqual(t.counterexample?.kind, "sequence");
    assert.ok((t.counterexample as { calls: unknown[] }).calls.length >= 1);
  });

  test("inherited test is reported under each contract", () => {
    assert.strictEqual(byName("CounterTest", "test_InheritedPasses").status, "passed");
    assert.strictEqual(byName("InvariantCounterTest", "test_InheritedPasses").status, "passed");
  });

  test("forge-std project output parses too", () => {
    const s = parseTestJson(data("forge-test-forgestd.json"));
    const inv = s.find((x) => x.contract === "InvariantCounterTest")!.tests.find((t) => t.name === "invariant_Small")!;
    assert.match(inv.reason!, /3 >= 3/);
    assert.strictEqual((inv.counterexample as { calls: { signature: string }[] }).calls[0].signature, "increment()");
  });

  test("tolerates log lines before the JSON, and rejects no JSON", () => {
    assert.strictEqual(parseTestJson("Compiling...\n" + data("forge-test.json")).length, 2);
    assert.throws(() => parseTestJson("Error: Compiler run failed"));
  });

  test("durations", () => {
    assert.strictEqual(parseDuration("5ms 790µs 416ns"), 5 + 0.79 + 0.000416);
    assert.strictEqual(parseDuration("1s 20ms"), 1020);
    assert.strictEqual(parseDuration({ secs: 1, nanos: 5e8 }), 1500);
    assert.strictEqual(parseDuration(null), undefined);
  });
});

suite("lcov", () => {
  test("reads lines, functions and branches", () => {
    const files = parseLcov(data("coverage.lcov"));
    // forge reports scripts too, not only src/.
    assert.deepStrictEqual(files.map((f) => f.file).sort(), ["script/Deploy.s.sol", "src/Counter.sol"]);
    const f = files.find((x) => x.file === "src/Counter.sol")!;
    assert.strictEqual(f.functions.find((x) => x.name === "Counter.untested")!.hits, 0);
    assert.ok(f.functions.find((x) => x.name === "Counter.setNumber")!.hits > 0);
    assert.ok(f.branches.length >= 1);
    const s = summarize(files);
    assert.ok(s.lines.total > s.lines.hit && s.lines.hit > 0);
  });
});

suite("gas snapshot", () => {
  test("unit and fuzz lines", () => {
    const snap = parseSnapshot("CounterTest:test_Increment() (gas: 51891)\nCounterTest:testFuzz_Set(uint256) (runs: 256, μ: 30521, ~: 31289)\nnot a line\n");
    assert.deepStrictEqual(snap.get("CounterTest:test_Increment()"), { gas: 51891, label: "gas" });
    assert.deepStrictEqual(snap.get("CounterTest:testFuzz_Set(uint256)"), { gas: 30521, label: "mean gas" });
  });

  test("describes changes", () => {
    assert.strictEqual(describeGas(gasChange(51891, undefined)), "51,891 gas");
    assert.strictEqual(describeGas(gasChange(52203, { gas: 51891, label: "gas" })), "52,203 gas (+312, +0.6%)");
    assert.strictEqual(describeGas(gasChange(51000, { gas: 52000, label: "gas" })), "51,000 gas (−1,000, −1.9%)");
    assert.strictEqual(describeGas(gasChange(10, { gas: 10, label: "gas" })), "10 gas");
  });
});

suite("forge text output", () => {
  test("compiler errors", () => {
    const m = parseCompilerMessages(data("compile-error.txt"));
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].severity, "error");
    assert.strictEqual(m[0].code, "6933");
    assert.strictEqual(m[0].file, "src/Counter.sol");
    assert.ok(m[0].line > 1 && m[0].column > 1);
  });

  test("coverage run results, including a multi-line invariant failure", () => {
    const r = parseTextResults(data("coverage.txt"));
    const key = (o: { contract: string; name: string; status: string }) => `${o.contract}.${o.name}:${o.status}`;
    assert.deepStrictEqual(r.map(key).sort(), [
      "CounterTest.testFuzz_SetNumber:failed",
      "CounterTest.test_FailsOnPurpose:failed",
      "CounterTest.test_Increment:passed",
      "CounterTest.test_InheritedPasses:passed",
      "InvariantCounterTest.invariant_Small:failed",
      "InvariantCounterTest.test_InheritedPasses:passed",
    ]);
    assert.strictEqual(r.find((o) => o.name === "test_FailsOnPurpose")!.reason, "number should be six");
    assert.match(r.find((o) => o.name === "testFuzz_SetNumber")!.reason!, /^TooBig\(.*\]\); counterexample: calldata=0x/);
  });
});

suite("traces", () => {
  test("nests calls, returns and events", () => {
    const t = parseTraces(data("trace-fail.txt"));
    assert.strictEqual(t.roots.length, 2);
    const [setUp, run] = t.roots;
    assert.strictEqual(setUp.fn, "setUp");
    assert.strictEqual(run.fn, "test_FailsOnPurpose");
    assert.strictEqual(run.target, "CounterTest");
    assert.ok(run.reverted);
    const set = run.children.find((c) => c.fn === "setNumber")!;
    assert.strictEqual(set.target, "Counter");
    assert.ok(set.gas! > 0);
    assert.ok(set.children.some((c) => c.kind === "emit"));
    assert.ok(!set.reverted);
    const view = run.children.find((c) => c.fn === "number")!;
    assert.strictEqual(view.callKind, "staticcall");
    const create = setUp.children.flatMap((c) => c.children).find((c) => c.kind === "create");
    assert.strictEqual(create?.target, "Counter");
  });

  test("a reverting call is marked", () => {
    const t = parseTraces(data("trace-fuzz.txt"));
    const run = t.roots[1];
    assert.ok(run.children[0].reverted);
    assert.strictEqual(run.children[0].children[0].status, "Revert");
  });
});
