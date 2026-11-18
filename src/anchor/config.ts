import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml, tomlNumber, tomlString, type TomlTables } from "./toml";
import { testScriptGlobs } from "./run";

// What the extension needs from an Anchor.toml.

export interface AnchorConfig {
  testScript?: string;
  /** Globs from the test script, or the usual tests folder. */
  testGlobs: string[];
  cluster: string;
  /** Anchor starts its own validator only for localnet; any other cluster means `anchor test` deploys there. */
  localnet: boolean;
  rpcPort: number;
  faucetPort: number;
  /** Program name → address, from [programs.localnet]. */
  programs: Map<string, string>;
}

export const defaultTestGlobs = ["tests/**/*.{ts,js,mjs,cjs}"];

export function anchorConfigFrom(tables: TomlTables): AnchorConfig {
  const testScript = tomlString(tables, "scripts", "test");
  const globs = testScript ? testScriptGlobs(testScript) : [];
  const cluster = tomlString(tables, "provider", "cluster") ?? "localnet";
  const programs = new Map<string, string>();
  for (const [k, v] of tables.get("programs.localnet") ?? []) if (typeof v === "string") programs.set(k, v);
  return {
    testScript,
    testGlobs: globs.length ? globs : defaultTestGlobs,
    cluster,
    localnet: /^(localnet|l)$/i.test(cluster.trim()),
    rpcPort: tomlNumber(tables, "test.validator", "rpc_port") ?? 8899,
    faucetPort: tomlNumber(tables, "test.validator", "faucet_port") ?? 9900,
    programs,
  };
}

export function readAnchorConfig(root: string): AnchorConfig {
  let text = "";
  try {
    text = fs.readFileSync(path.join(root, "Anchor.toml"), "utf8");
  } catch {
    // An unreadable Anchor.toml gives the defaults.
  }
  return anchorConfigFrom(parseToml(text));
}
