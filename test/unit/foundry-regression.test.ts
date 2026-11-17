import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { importsForgeStd, insertion, regressionTest } from "../../src/foundry/regression";
import { parseTestJson } from "../../src/foundry/results";

const data = (f: string) => fs.readFileSync(path.join(__dirname, "../../../test/unit/data", f), "utf8");

suite("Regression tests", () => {
  const suites = parseTestJson(data("forge-test.json"));
  const fuzz = suites.find((s) => s.contract === "CounterTest")!.tests.find((t) => t.name === "testFuzz_SetNumber")!;
  const inv = suites.find((s) => s.contract === "InvariantCounterTest")!.tests.find((t) => t.name === "invariant_Small")!;

  test("a fuzz counterexample becomes a typed call", () => {
    const { name, code } = regressionTest({ testName: fuzz.name, params: "uint256 x", counterexample: fuzz.counterexample!, existing: new Set(), hasVm: false });
    assert.strictEqual(name, "test_Regression_testFuzz_SetNumber_1");
    const value = BigInt("0x" + (fuzz.counterexample as { calldata: string }).calldata.slice(10)).toString();
    assert.ok(code.includes(`testFuzz_SetNumber(${value});`), code);
  });

  test("names do not collide", () => {
    const { name } = regressionTest({
      testName: fuzz.name,
      params: "uint256 x",
      counterexample: fuzz.counterexample!,
      existing: new Set(["test_Regression_testFuzz_SetNumber_1"]),
      hasVm: true,
    });
    assert.strictEqual(name, "test_Regression_testFuzz_SetNumber_2");
  });

  test("complex parameters replay the calldata", () => {
    const { code } = regressionTest({ testName: "testFuzz_Arr", params: "uint256[] memory a", counterexample: { kind: "single", calldata: "0x12345678" + "0".repeat(62) + "20" + "0".repeat(64), args: "[]" }, existing: new Set(), hasVm: true });
    assert.ok(code.includes('address(this).call(hex"12345678'));
    assert.ok(code.includes("revert(add(ret, 32), mload(ret))"));
  });

  test("an invariant sequence uses vm when available, the cheatcode address otherwise", () => {
    const withVm = regressionTest({ testName: inv.name, params: "", counterexample: inv.counterexample!, existing: new Set(), hasVm: true }).code;
    assert.ok(withVm.includes("vm.prank(0x"));
    assert.ok(withVm.trimEnd().endsWith("invariant_Small();\n    }") || withVm.includes("invariant_Small();"));
    const without = regressionTest({ testName: inv.name, params: "", counterexample: inv.counterexample!, existing: new Set(), hasVm: false }).code;
    assert.ok(!without.includes("vm."));
    assert.ok(without.includes('address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).call(abi.encodeWithSignature("prank(address)"'));
  });

  test("inserted before the contract's closing brace", () => {
    const src = "contract A {\n    function a() public {}\n}\n\ncontract B {\n    function b() public {}\n}\n";
    const at = insertion(src, "A", "    function x() public {}")!;
    const out = src.slice(0, at.offset) + at.text + src.slice(at.offset);
    assert.strictEqual(out, "contract A {\n    function a() public {}\n\n    function x() public {}\n}\n\ncontract B {\n    function b() public {}\n}\n");
    assert.strictEqual(insertion(src, "Missing", "x"), undefined);
  });

  test("forge-std detection", () => {
    assert.ok(importsForgeStd('import {Test} from "forge-std/Test.sol";'));
    assert.ok(!importsForgeStd('import {Counter} from "../src/Counter.sol";'));
  });
});
