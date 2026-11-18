import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, foundryRoot, waitFor } from "./helpers";
import type { LayoutIssue, StorageLayout } from "../../../src/security/layout";

// Writes an upgradeable contract into the fixture for the length of the suite, so other suites see the fixture as it is.
const file = path.join(foundryRoot, "src", "Upgradeable.sol");
const v1 = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Initializable {
    uint8 private _initialized;
    bool private _initializing;
}

contract Vault is Initializable {
    struct Position {
        uint128 amount;
        uint64 since;
    }

    uint256 public total;
    mapping(address => Position) public positions;
    uint256[48] private __gap;

    function initialize() external {}
}
`;
const storageDiagnostics = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "ForgeDefender storage");

suite("Security: storage layout", () => {
  const uri = vscode.Uri.file(file);

  suiteSetup(() => fs.writeFileSync(file, v1));
  suiteTeardown(() => {
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(foundryRoot, ".forgedefender"), { recursive: true, force: true });
    fs.rmSync(path.join(foundryRoot, "out", "Upgradeable.sol"), { recursive: true, force: true });
  });

  test("suggests a baseline on an upgradeable contract", async () => {
    await activate();
    await vscode.window.showTextDocument(uri);
    const lenses = await waitFor(async () => {
      const l = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
      return l?.some((x) => x.command?.title === "Save storage baseline") ? l : undefined;
    }, "storage code lens", 30_000);
    const lens = lenses.find((x) => x.command?.title === "Save storage baseline")!;
    assert.strictEqual(lens.range.start.line, 8);
  });

  test("shows the layout of a contract", async () => {
    const layout = await vscode.commands.executeCommand<StorageLayout>("forgeDefender.security.showStorageLayout", uri, "Vault");
    assert.deepStrictEqual(
      layout.storage.map((e) => [e.label, e.slot, e.offset]),
      [
        ["_initialized", "0", 0],
        ["_initializing", "0", 1],
        ["total", "1", 0],
        ["positions", "2", 0],
        ["__gap", "3", 0],
      ],
    );
  });

  test("saves a baseline and finds a break against it", async () => {
    const saved = await vscode.commands.executeCommand<string>("forgeDefender.security.saveStorageBaseline", uri, "Vault");
    assert.strictEqual(saved, path.join(foundryRoot, ".forgedefender", "storage", "src", "Upgradeable.sol", "Vault.json"));
    const baseline = JSON.parse(fs.readFileSync(saved, "utf8"));
    assert.strictEqual(baseline.contract, "src/Upgradeable.sol:Vault");

    const ok = await vscode.commands.executeCommand<Record<string, LayoutIssue[]>>("forgeDefender.security.checkStorageLayouts", foundryRoot, true);
    assert.deepStrictEqual(ok, { "src/Upgradeable.sol:Vault": [] });

    // v2: a variable inserted before `total`, and one appended in the gap correctly.
    fs.writeFileSync(file, v1.replace("uint256 public total;", "uint256 public admin;\n    uint256 public total;"));
    const bad = await vscode.commands.executeCommand<Record<string, LayoutIssue[]>>("forgeDefender.security.checkStorageLayouts", foundryRoot, true);
    const kinds = bad["src/Upgradeable.sol:Vault"].map((i) => `${i.kind}:${i.label}`).sort();
    assert.ok(kinds.includes("inserted:admin"), kinds.join());
    assert.ok(kinds.includes("moved:total"), kinds.join());
    const diags = storageDiagnostics(uri);
    assert.ok(diags.length >= 2);
    assert.ok(diags.every((d) => d.range.start.line === 8));
    assert.ok(diags.some((d) => d.severity === vscode.DiagnosticSeverity.Error && /admin inserted at slot/.test(d.message)));
  });

  test("checks again after a test run", async () => {
    const ctx = await activate();
    fs.writeFileSync(file, v1.replace("uint256[48] private __gap;", "uint256 public fee;\n    uint256[47] private __gap;"));
    const project = (await ctx.foundryProjects())[0];
    ctx.publishFoundryRun({ project, suites: [], complete: true });
    await waitFor(() => storageDiagnostics(uri).length === 0 || undefined, "storage diagnostics to clear");
  });
});
