import * as assert from "node:assert";
import { activate, foundryRoot } from "./helpers";

suite("Activation", () => {
  test("finds the Foundry fixture project", async () => {
    const ctx = await activate();
    const projects = await ctx.foundryProjects();
    assert.deepStrictEqual(
      projects.map((p) => p.root),
      [foundryRoot],
    );
    assert.strictEqual(projects[0].config.src, "src");
  });
});
