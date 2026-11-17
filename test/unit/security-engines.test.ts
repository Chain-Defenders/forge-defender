import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { aderyn, inDependency, slither } from "../../src/security/engines";

// Real output: `slither . --json -` (0.11.0) and `aderyn . --output report.json` (0.6.8) on the Foundry fixture, and on
// a project with a library in lib/ (see test/unit/data/engines).
const dir = path.resolve(__dirname, "../../../test/unit/data/engines");
const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

suite("security: analysis engines", () => {
  test("Slither on the fixture", () => {
    const f = slither.parse(read("slither-fixture.json"));
    assert.deepStrictEqual(
      f.map((x) => [x.detector, x.severity, x.file, x.line]),
      [
        ["solc-version", "info", "src/Counter.sol", 2],
        ["immutable-states", "optimization", "src/Counter.sol", 7],
      ],
    );
    assert.match(f[1].title, /Counter.owner .* should be immutable/);
  });

  test("Slither skips findings only in dependencies and keeps mixed ones on the project's side", () => {
    const f = slither.parse(read("slither-withlib.json"));
    assert.deepStrictEqual(
      f.map((x) => [x.detector, x.severity, x.file, x.line]),
      [
        ["reentrancy-eth", "high", "src/App.sol", 6],
        ["pragma", "info", "src/App.sol", 2],
        ["low-level-calls", "info", "src/App.sol", 6],
      ],
    );
    assert.ok(f.every((x) => !inDependency(x.file)));
    assert.ok(f[0].related.length > 0);
  });

  test("Slither's failure is an error", () => {
    assert.throws(() => slither.parse('{"success": false, "error": "Invalid compilation", "results": {}}'), /Invalid compilation/);
  });

  test("Aderyn on the fixture: one finding per instance", () => {
    const f = aderyn.parse(read("aderyn-fixture.json"));
    assert.deepStrictEqual(
      f.map((x) => [x.detector, x.file, x.line]),
      [
        ["push-zero-opcode", "src/Counter.sol", 2],
        ["state-change-without-event", "src/Counter.sol", 23],
        ["state-variable-could-be-immutable", "src/Counter.sol", 7],
        ["unspecific-solidity-pragma", "src/Counter.sol", 2],
        ["unused-public-function", "src/Counter.sol", 17],
        ["unused-public-function", "src/Counter.sol", 23],
      ],
    );
    assert.ok(f.every((x) => x.severity === "low" && x.docs?.endsWith("/detect/low")));
  });

  test("Aderyn high findings", () => {
    const f = aderyn.parse(read("aderyn-withlib.json"));
    assert.deepStrictEqual(
      f.filter((x) => x.severity === "high").map((x) => [x.detector, x.line]),
      [
        ["eth-send-unchecked-address", 6],
        ["reentrancy-state-change", 8],
      ],
    );
  });

  test("dependency paths", () => {
    assert.ok(inDependency("lib/forge-std/src/Test.sol"));
    assert.ok(inDependency("node_modules/@openzeppelin/contracts/token/ERC20.sol"));
    assert.ok(inDependency("dependencies/solady-0.1.0/src/Foo.sol"));
    assert.ok(!inDependency("src/library/Math.sol"));
  });
});
