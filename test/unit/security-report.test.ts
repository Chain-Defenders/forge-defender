import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLcov } from "../../src/foundry/lcov";
import { buildReport, floatingPragmas, isInterfaceFile, isMock, scopeText, todos } from "../../src/security/report";
import { readinessHtml } from "../../src/security/html";

// The fixture's Counter.sol and the lcov `forge coverage --report lcov` (forge 1.9.0) wrote for the fixture.
const counter = fs.readFileSync(path.resolve(__dirname, "../../../test/fixtures/foundry/src/Counter.sol"), "utf8");
const lcov = parseLcov(`TN:
SF:script/Deploy.s.sol
DA:14,0
FN:14,DeployScript.run
FNDA:0,DeployScript.run
DA:15,0
DA:16,0
DA:17,0
FNF:1
FNH:0
LF:4
LH:0
BRF:0
BRH:0
end_of_record
TN:
SF:src/Counter.sol
DA:12,6
FN:12,Counter.constructor
FNDA:6,Counter.constructor
DA:13,6
DA:17,4
FN:17,Counter.setNumber
FNDA:4,Counter.setNumber
DA:18,4
BRDA:18,0,0,0
DA:19,4
DA:20,4
DA:23,1
FN:23,Counter.increment
FNDA:1,Counter.increment
DA:24,1
DA:27,0
FN:27,Counter.untested
FNDA:0,Counter.untested
DA:28,0
FNF:4
FNH:3
LF:10
LH:8
BRF:1
BRH:0
end_of_record
`);

const iface = "// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n\ninterface ICounter {\n    function number() external view returns (uint256);\n}\n";
const mock = "pragma solidity >=0.8.0 <0.9.0;\n\ncontract MockToken {\n    // TODO: not in scope\n    function mint() external {}\n}\n";

const make = (today: string, extra: { rel: string; text: string }[] = []) =>
  buildReport({
    project: "foundry",
    files: [{ rel: "src/Counter.sol", text: counter }, { rel: "src/interfaces/ICounter.sol", text: iface }, { rel: "src/mocks/MockToken.sol", text: mock }, ...extra],
    lcov,
    tests: { passed: 2, failed: 3, skipped: 0, at: "18 Nov 2026" },
    today: new Date(`${today}T12:00:00`),
    grantUrl: "https://chaindefenders.xyz/audit-grants?utm_campaign=audit-readiness",
    estimateUrl: "https://chaindefenders.xyz/web3#estimate",
  });

suite("security: audit readiness", () => {
  test("splits scope, interfaces and mocks, with nSLOC", () => {
    const r = make("2026-11-18");
    assert.deepStrictEqual(r.scope, [{ file: "src/Counter.sol", nsloc: 21 }]);
    assert.deepStrictEqual(r.interfaces.map((f) => f.file), ["src/interfaces/ICounter.sol"]);
    assert.deepStrictEqual(r.mocks.map((f) => f.file), ["src/mocks/MockToken.sol"]);
    assert.strictEqual(r.nsloc, 21);
    assert.strictEqual(scopeText(r), "src/Counter.sol\n");
  });

  test("coverage only counts in-scope files", () => {
    const r = make("2026-11-18");
    assert.deepStrictEqual(r.coverage, { lines: { hit: 8, total: 10 }, functions: { hit: 3, total: 4 }, branches: { hit: 0, total: 1 } });
    assert.deepStrictEqual(r.unexecuted, [{ file: "src/Counter.sol", line: 27, text: "Counter.untested" }]);
  });

  test("NatSpec, pragmas and TODOs in scope", () => {
    const r = make("2026-11-18");
    assert.deepStrictEqual(r.missingNatspec.map((p) => p.text), ["Counter.increment", "Counter.untested"]);
    assert.deepStrictEqual(r.floatingPragmas, [{ file: "src/Counter.sol", line: 2, text: "pragma solidity ^0.8.20" }]);
    assert.strictEqual(r.todos.length, 0);
    assert.strictEqual(floatingPragmas("a.sol", "pragma solidity 0.8.28;").length, 0);
    assert.strictEqual(floatingPragmas("a.sol", "pragma solidity =0.8.28;").length, 0);
    assert.strictEqual(floatingPragmas("a.sol", "// pragma solidity ^0.8.0;\npragma solidity >=0.8.0;").length, 1);
    assert.deepStrictEqual(todos("a.sol", "x\n// FIXME: overflow\n").map((t) => t.line), [2]);
  });

  test("classifies interfaces and mocks by content too", () => {
    assert.ok(isInterfaceFile("src/ICounter.sol", iface));
    assert.ok(!isInterfaceFile("src/Counter.sol", counter));
    assert.ok(isMock("src/Token.sol", mock));
    assert.ok(!isMock("src/Counter.sol", counter));
  });

  test("the grant line shows up to 15 December 2026 and up to 4,000 nSLOC", () => {
    assert.ok(make("2026-12-15").grant);
    assert.strictEqual(make("2026-12-16").grant, undefined);
    const big = { rel: "src/Big.sol", text: "contract Big {\n" + "    uint256 a;\n".repeat(4000) + "}\n" };
    assert.strictEqual(make("2026-11-18", [big]).grant, undefined);
  });

  test("the page has one call to action and the grant link", () => {
    const r = make("2026-11-18");
    const html = readinessHtml(r, { open: (f, l) => `command:open?${f}:${l}` }, { writeScope: "command:scope" }, "vscode-resource:");
    assert.strictEqual(html.match(/web3#estimate/g)?.length, 1);
    assert.strictEqual(html.match(/audit-grants/g)?.length, 1);
    assert.ok(html.includes("Counter.untested"));
    assert.ok(!/<script/i.test(html));
  });
});
