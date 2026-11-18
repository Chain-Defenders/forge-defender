import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { exec } from "./exec";
import { tool } from "./tools";

// A workspace can hold several projects (a monorepo with contracts/ and programs/). Each Foundry project is the
// folder of a foundry.toml, each Anchor project the folder of an Anchor.toml, at any depth. The
// `forgeDefender.projects` setting replaces that search with a fixed list of folders.

export interface FoundryConfig {
  src: string;
  test: string;
  script: string;
  out: string;
  libs: string[];
  cache_path: string;
  broadcast: string;
  rpc_endpoints?: Record<string, string>;
  etherscan?: Record<string, { key?: string; chain?: string | number; url?: string }>;
}

export interface FoundryProject {
  kind: "foundry";
  root: string;
  name: string;
  config: FoundryConfig;
}

export interface AnchorProject {
  kind: "anchor";
  root: string;
  name: string;
}

export type Project = FoundryProject | AnchorProject;

const defaults: FoundryConfig = {
  src: "src",
  test: "test",
  script: "script",
  out: "out",
  libs: ["lib"],
  cache_path: "cache",
  broadcast: "broadcast",
};

const skip = "{**/node_modules/**,**/lib/**,**/dependencies/**,**/.git/**,**/target/**}";

/** The projects from the `forgeDefender.projects` setting when it lists any, otherwise those found in the workspace. */
export async function findProjects(log?: vscode.LogOutputChannel): Promise<Project[]> {
  const listed = listedRoots();
  if (listed.length) return listedProjects(listed, log);
  const [foundry, anchor] = await Promise.all([
    vscode.workspace.findFiles("**/foundry.toml", skip, 50),
    vscode.workspace.findFiles("**/Anchor.toml", skip, 50),
  ]);
  const projects: Project[] = [];
  for (const uri of foundry) {
    const root = path.dirname(uri.fsPath);
    projects.push({ kind: "foundry", root, name: path.basename(root), config: await foundryConfig(root) });
  }
  for (const uri of anchor) {
    const root = path.dirname(uri.fsPath);
    projects.push({ kind: "anchor", root, name: path.basename(root) });
  }
  return projects.sort((a, b) => a.root.localeCompare(b.root));
}

/** The folders in `forgeDefender.projects`, absolute; relative ones are resolved against their workspace folder. */
export function listedRoots(): string[] {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const entries = vscode.workspace.getConfiguration("forgeDefender", folder.uri).get<string[]>("projects") ?? [];
    for (const entry of entries) {
      if (typeof entry === "string" && entry.trim()) roots.add(path.resolve(folder.uri.fsPath, entry.trim()));
    }
  }
  return [...roots];
}

// A listed folder is an Anchor project when it has an Anchor.toml, otherwise a Foundry one: forge runs with its
// defaults when there is no foundry.toml.
async function listedProjects(roots: string[], log?: vscode.LogOutputChannel): Promise<Project[]> {
  const projects: Project[] = [];
  for (const root of roots) {
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      log?.warn(`forgeDefender.projects: ${root} is not a folder`);
      continue;
    }
    if (fs.existsSync(path.join(root, "Anchor.toml"))) projects.push({ kind: "anchor", root, name: path.basename(root) });
    else projects.push({ kind: "foundry", root, name: path.basename(root), config: await foundryConfig(root) });
  }
  return projects.sort((a, b) => a.root.localeCompare(b.root));
}

/** The resolved configuration, from forge itself so profiles and remappings are right; defaults when forge is missing. */
export async function foundryConfig(root: string): Promise<FoundryConfig> {
  const r = await exec(tool("forge"), ["config", "--json"], { cwd: root, timeoutMs: 30_000 });
  if (r.code === 0) {
    try {
      return { ...defaults, ...JSON.parse(r.stdout) };
    } catch {
      // fall through
    }
  }
  return { ...defaults };
}

/** The project a file belongs to: the deepest project root that contains it. */
export function projectOf<T extends Project>(projects: T[], file: string): T | undefined {
  let best: T | undefined;
  for (const p of projects) {
    if ((file === p.root || file.startsWith(p.root + path.sep)) && (!best || p.root.length > best.root.length)) best = p;
  }
  return best;
}

/** Lists files under `dir` with one of the suffixes, skipping dependency and build folders. */
export function walk(dir: string, suffixes: string[], skipDirs = ["node_modules", "lib", "dependencies", ".git", "out", "cache", "target"]): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.includes(e.name) && !e.name.startsWith(".")) visit(p);
      } else if (suffixes.some((s) => e.name.endsWith(s))) out.push(p);
    }
  };
  visit(dir);
  return out.sort();
}
