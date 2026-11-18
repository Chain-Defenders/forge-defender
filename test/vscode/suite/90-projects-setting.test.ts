import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, waitFor, workspace } from "./helpers";

// Last, because changing the project list makes every feature rediscover.

suite("The forgeDefender.projects setting", () => {
  const config = () => vscode.workspace.getConfiguration("forgeDefender");

  teardown(async () => {
    await config().update("projects", undefined, vscode.ConfigurationTarget.Workspace);
  });

  test("replaces the search; a folder without a config file is a Foundry project and a missing one is skipped", async () => {
    const ctx = await activate();
    await config().update("projects", ["foundry", "anchor", "chain", "missing"], vscode.ConfigurationTarget.Workspace);
    const projects = await waitFor(async () => {
      const p = await ctx.projects();
      return p.length === 3 ? p : undefined;
    }, "the listed projects");
    assert.deepStrictEqual(
      projects.map((p) => [p.kind, path.relative(workspace, p.root)]),
      [
        ["anchor", "anchor"],
        ["foundry", "chain"],
        ["foundry", "foundry"],
      ],
    );
    const chain = projects.find((p) => p.name === "chain")!;
    assert.strictEqual(chain.kind === "foundry" && chain.config.src, "src");

    await config().update("projects", undefined, vscode.ConfigurationTarget.Workspace);
    await waitFor(async () => ((await ctx.projects()).length === 2 ? true : undefined), "the search again");
  });
});
