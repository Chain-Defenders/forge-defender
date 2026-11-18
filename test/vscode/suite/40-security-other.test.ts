import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, foundryRoot } from "./helpers";
import { parseLcov } from "../../../src/foundry/lcov";
import type { Hit } from "../../../src/security/dependencies";
import type { Finding } from "../../../src/security/engines";
import type { ReadinessReport } from "../../../src/security/report";

// Dependencies, static analysis and audit readiness on the Foundry fixture. Anything written into the fixture is
// removed again, so later suites see it unchanged.

suite("Security: dependencies", () => {
  const written = [path.join(foundryRoot, ".gitmodules"), path.join(foundryRoot, "lib")];
  suiteTeardown(() => written.forEach((f) => fs.rmSync(f, { recursive: true, force: true })));

  test("flags an old OpenZeppelin submodule on its .gitmodules line", async () => {
    await activate();
    fs.writeFileSync(
      written[0],
      '[submodule "lib/openzeppelin-contracts"]\n\tpath = lib/openzeppelin-contracts\n\turl = https://github.com/OpenZeppelin/openzeppelin-contracts\n',
    );
    const pkg = path.join(written[1], "openzeppelin-contracts", "contracts", "package.json");
    fs.mkdirSync(path.dirname(pkg), { recursive: true });
    fs.writeFileSync(pkg, '{"name":"@openzeppelin/contracts","version":"4.7.0"}');

    const hits = await vscode.commands.executeCommand<Hit[]>("forgeDefender.security.checkDependencies", true);
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.dep.name === "@openzeppelin/contracts" && h.dep.version === "4.7.0"));
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(written[0])).filter((d) => d.source === "ForgeDefender advisories");
    assert.strictEqual(diags.length, new Set(hits.map((h) => h.advisory.id)).size);
    const ecdsa = diags.find((d) => typeof d.code === "object" && d.code.value === "GHSA-4h98-2769-gh6h");
    assert.ok(ecdsa, "the ECDSA malleability advisory");
    assert.strictEqual(ecdsa.range.start.line, 0);
    assert.strictEqual(ecdsa.severity, vscode.DiagnosticSeverity.Error);
    assert.match(ecdsa.message, /@openzeppelin\/contracts 4\.7\.0: .*\(high\)\. Fixed in 4\.7\.3\./);
    assert.strictEqual((ecdsa.code as { target: vscode.Uri }).target.toString(), "https://github.com/advisories/GHSA-4h98-2769-gh6h");
  });

  test("clears once the dependency is gone", async () => {
    written.forEach((f) => fs.rmSync(f, { recursive: true, force: true }));
    const hits = await vscode.commands.executeCommand<Hit[]>("forgeDefender.security.checkDependencies", true);
    assert.deepStrictEqual(hits, []);
    assert.strictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(written[0])).length, 0);
  });
});

suite("Security: static analysis", () => {
  const counter = vscode.Uri.file(path.join(foundryRoot, "src", "Counter.sol"));
  const config = () => vscode.workspace.getConfiguration("forgeDefender.security.analysis");
  suiteTeardown(async () => {
    await config().update("engine", undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand("forgeDefender.security.clearAnalysis");
  });

  for (const [engine, label, detector] of [
    ["slither", "Slither", "immutable-states"],
    ["aderyn", "Aderyn", "state-variable-could-be-immutable"],
  ] as const) {
    test(`${label} findings become diagnostics`, async () => {
      await activate();
      await config().update("engine", engine, vscode.ConfigurationTarget.Workspace);
      const findings = await vscode.commands.executeCommand<Finding[] | undefined>("forgeDefender.security.runAnalysis", foundryRoot, true);
      assert.ok(findings, `${label} ran`);
      assert.ok(findings.every((f) => f.engine === engine));
      const diags = vscode.languages.getDiagnostics(counter).filter((d) => d.source === label);
      const d = diags.find((x) => typeof x.code === "object" && x.code.value === detector);
      assert.ok(d, `${detector} in ${diags.map((x) => JSON.stringify(x.code)).join()}`);
      assert.strictEqual(d.range.start.line, 6, "on `address public owner;`");
      assert.match((d.code as { target: vscode.Uri }).target.toString(), engine === "slither" ? /Detector-Documentation#state-variables-that-could-be-declared-immutable/ : /aderyn/);
    });
  }
});

suite("Security: audit readiness", () => {
  const scope = path.join(foundryRoot, "scope.txt");
  suiteTeardown(async () => {
    fs.rmSync(scope, { force: true });
    (await activate()).lastCoverage.delete(foundryRoot);
  });

  test("reports scope, coverage and the last run", async () => {
    const ctx = await activate();
    const project = (await ctx.foundryProjects())[0];
    // Real lcov from `forge coverage --report lcov` on the fixture (forge 1.9.0), trimmed to Counter.sol.
    const lcov = parseLcov(
      "SF:src/Counter.sol\nDA:12,6\nFN:12,Counter.constructor\nFNDA:6,Counter.constructor\nDA:13,6\nDA:17,4\nFN:17,Counter.setNumber\nFNDA:4,Counter.setNumber\nDA:18,4\nBRDA:18,0,0,0\nDA:19,4\nDA:20,4\nDA:23,1\nFN:23,Counter.increment\nFNDA:1,Counter.increment\nDA:24,1\nDA:27,0\nFN:27,Counter.untested\nFNDA:0,Counter.untested\nDA:28,0\nend_of_record\n",
    );
    ctx.publishCoverage({ project, lcov });
    ctx.publishFoundryRun({
      project,
      complete: true,
      suites: [
        {
          file: "test/Counter.t.sol",
          contract: "CounterTest",
          warnings: [],
          tests: [
            { name: "test_Increment", signature: "test_Increment()", status: "passed", invariantFailures: [], logs: [], kind: "unit" },
            { name: "test_FailsOnPurpose", signature: "test_FailsOnPurpose()", status: "failed", invariantFailures: [], logs: [], kind: "unit" },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const r = await vscode.commands.executeCommand<ReadinessReport>("forgeDefender.security.auditReadiness", foundryRoot);
    assert.deepStrictEqual(r.scope, [{ file: "src/Counter.sol", nsloc: 21 }]);
    assert.strictEqual(r.nsloc, 21);
    assert.deepStrictEqual(r.coverage?.lines, { hit: 8, total: 10 });
    assert.deepStrictEqual(r.unexecuted.map((u) => u.text), ["Counter.untested"]);
    assert.deepStrictEqual(r.missingNatspec.map((u) => u.text), ["Counter.increment", "Counter.untested"]);
    assert.strictEqual(r.floatingPragmas.length, 1);
    assert.deepStrictEqual([r.tests?.passed, r.tests?.failed], [1, 1]);
    assert.match(r.estimateUrl, /^https:\/\/chaindefenders\.xyz\/web3\?.*utm_campaign=audit-readiness.*#estimate$/);
    if (new Date() < new Date(2026, 11, 16)) assert.match(r.grant?.url ?? "", /^https:\/\/chaindefenders\.xyz\/audit-grants\?utm_source=forgedefender/);
  });

  test("writes scope.txt", async () => {
    const file = await vscode.commands.executeCommand<string>("forgeDefender.security.writeScope", foundryRoot);
    assert.strictEqual(file, scope);
    assert.strictEqual(fs.readFileSync(scope, "utf8"), "src/Counter.sol\n");
  });
});
