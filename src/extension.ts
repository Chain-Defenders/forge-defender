import * as vscode from "vscode";
import { Ctx } from "./core/context";
import { killAll } from "./core/exec";
import * as foundryTesting from "./foundry/testing";
import * as trace from "./foundry/trace";
import * as keymoat from "./keymoat/panel";
import * as localChain from "./chain/local";
import * as deployments from "./foundry/deployments";
import * as deploy from "./foundry/deploy";
import * as sizes from "./foundry/sizes";
import * as selectors from "./foundry/selectors";
import * as storage from "./security/storage";
import * as advisories from "./security/advisories";
import * as analysis from "./security/analysis";
import * as readiness from "./security/readiness";
import * as anchorTesting from "./anchor/testing";
import * as solanaTools from "./solana/tools";

// Each feature registers itself on the shared context. One feature failing to start must not take the others down.
const features: [string, { register(ctx: Ctx): void }][] = [
  ["Foundry tests", foundryTesting],
  ["Traces", trace],
  ["keymoat", keymoat],
  ["Local chain", localChain],
  ["Deployments", deployments],
  ["Deploy", deploy],
  ["Contract sizes", sizes],
  ["Selectors", selectors],
  ["Storage layout", storage],
  ["Dependency advisories", advisories],
  ["Static analysis", analysis],
  ["Audit readiness", readiness],
  ["Anchor tests", anchorTesting],
  ["Solana tools", solanaTools],
];

export function activate(context: vscode.ExtensionContext) {
  const ctx = new Ctx(context);
  context.subscriptions.push(ctx);
  for (const [name, feature] of features) {
    try {
      feature.register(ctx);
    } catch (e) {
      ctx.log.error(`${name} did not start: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }
  return ctx;
}

export function deactivate() {
  // A window reload must not leave forge, anchor or a validator running in the background.
  killAll();
}
