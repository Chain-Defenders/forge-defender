import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { blankCommentsAndStrings, countNsloc, paramTypes, parseSolidity } from "../../src/core/solidity";
import { discoverTests, parseAll } from "../../src/foundry/discover";
import { checksumAddress, decodeSimple, selector, solidityLiteral } from "../../src/core/abi";

const fixture = path.join(__dirname, "../../../test/fixtures/foundry");
const read = (f: string) => fs.readFileSync(path.join(fixture, f), "utf8");

suite("Solidity reader", () => {
  test("blanking keeps offsets and lines", () => {
    const src = 'a // c {\nb /* x\n} */ "s{"\n';
    const out = blankCommentsAndStrings(src);
    assert.strictEqual(out.length, src.length);
    assert.strictEqual(out.split("\n").length, src.split("\n").length);
    assert.ok(!out.includes("{") && !out.includes("}"));
  });

  test("contracts, bases, functions and NatSpec", () => {
    const f = parseSolidity(read("src/Counter.sol"));
    assert.strictEqual(f.contracts.length, 1);
    const c = f.contracts[0];
    assert.strictEqual(c.name, "Counter");
    assert.strictEqual(c.line, 4);
    const set = c.functions.find((x) => x.name === "setNumber")!;
    assert.strictEqual(set.visibility, "public");
    assert.strictEqual(set.natspec, true);
    assert.strictEqual(set.params, "uint256 newNumber");
    assert.strictEqual(c.functions.find((x) => x.name === "increment")!.natspec, false);
    assert.strictEqual(c.functions.find((x) => x.name === "untested")!.mutability, "pure");
    assert.deepStrictEqual(c.declarations.map((d) => `${d.kind} ${d.name}`), ["error TooBig", "event Set"]);
  });

  test("abstract, interfaces and bases with arguments", () => {
    const f = parseSolidity(`
      interface I { function f() external; }
      abstract contract A is I, Ownable(msg.sender) { function g() internal {} }
      library L { function h(uint256[] memory a, bytes calldata) internal pure returns (uint256) { return 1; } }
    `);
    assert.deepStrictEqual(f.contracts.map((c) => [c.name, c.kind, c.abstract]), [["I", "interface", false], ["A", "contract", true], ["L", "library", false]]);
    assert.deepStrictEqual(f.contracts[1].bases, ["I", "Ownable"]);
    assert.deepStrictEqual(paramTypes(f.contracts[2].functions[0].params), ["uint256[]", "bytes"]);
  });

  test("nSLOC skips comments and blank lines", () => {
    assert.strictEqual(countNsloc("// a\n\n/* b\n c */\ncontract X {\n  uint a; // x\n}\n"), 3);
  });
});

suite("Test discovery", () => {
  const files = parseAll(new Map([["test/Base.t.sol", read("test/Base.t.sol")], ["test/Counter.t.sol", read("test/Counter.t.sol")]]));
  const found = discoverTests(files);

  test("abstract bases are not runnable, their tests are inherited", () => {
    assert.deepStrictEqual([...found.keys()], ["test/Counter.t.sol"]);
    const contracts = found.get("test/Counter.t.sol")!;
    assert.deepStrictEqual(contracts.map((c) => c.name), ["CounterTest", "InvariantCounterTest"]);
    const counter = contracts[0];
    assert.deepStrictEqual(counter.tests.map((t) => t.name), ["test_Increment", "test_FailsOnPurpose", "testFuzz_SetNumber", "test_InheritedPasses"]);
    const inherited = counter.tests.find((t) => t.name === "test_InheritedPasses")!;
    assert.strictEqual(inherited.file, "test/Base.t.sol");
    assert.strictEqual(inherited.inheritedFrom, "BaseTest");
  });

  test("kinds, and nothing from comments or internal helpers", () => {
    const [counter, inv] = found.get("test/Counter.t.sol")!;
    assert.strictEqual(counter.tests.find((t) => t.name === "testFuzz_SetNumber")!.kind, "fuzz");
    assert.strictEqual(inv.tests.find((t) => t.name === "invariant_Small")!.kind, "invariant");
    assert.ok(!counter.tests.some((t) => t.name === "test_NotATest" || t.name === "helper"));
  });

  test("an override wins over the base's test", () => {
    const f = parseAll(
      new Map([
        ["a.sol", "abstract contract B { function test_X() public virtual {} }"],
        ["b.sol", "contract C is B { function test_X() public override {} }"],
      ]),
    );
    const t = discoverTests(f).get("b.sol")![0].tests;
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].file, "b.sol");
    assert.strictEqual(t[0].inheritedFrom, undefined);
  });
});

suite("ABI helpers", () => {
  test("selectors and checksums match known values", () => {
    assert.strictEqual(selector("transfer(address,uint256)"), "0xa9059cbb");
    assert.strictEqual(selector("increment()"), "0xd09de08a");
    // EIP-55's own examples.
    assert.strictEqual(checksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    assert.strictEqual(checksumAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"), "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359");
  });

  test("decodes simple types and refuses the rest", () => {
    const word = (h: string) => h.padStart(64, "0");
    const data = word("2a") + word("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") + word("1") + "f".repeat(64) + word("a0") + word("3") + "616263".padEnd(64, "0");
    const d = decodeSimple(["uint256", "address", "bool", "int8", "string"], data)!;
    assert.deepStrictEqual(
      d.map((x) => x.value),
      ["42", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "true", "-1", "abc"],
    );
    assert.strictEqual(decodeSimple(["uint256[]"], word("20") + word("0")), undefined);
    assert.strictEqual(solidityLiteral({ type: "string", value: 'a"b' }), 'string(hex"612262")');
    assert.strictEqual(solidityLiteral({ type: "int8", value: "-1" }), "int8(-1)");
  });
});
