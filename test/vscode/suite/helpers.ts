import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../../../src/core/context";

// Shared by the in-editor tests: the workspace copy, the activated extension's context, and waiting for a condition.

export const workspace = process.env.FORGEDEFENDER_TEST_WORKSPACE!;
export const foundryRoot = path.join(workspace, "foundry");

export async function activate(): Promise<Ctx> {
  const ext = vscode.extensions.getExtension("ChainDefenders.forgedefender")!;
  return (await ext.activate()) as Ctx;
}

export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, what: string, ms = 120_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
