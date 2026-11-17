import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "../core/exec";
import { inRange } from "./semver";

// Finds the installed versions of the dependencies the advisory data covers, and the line that declares each one, so
// a warning lands where the developer would change it. No vscode here: the editor part is in advisories.ts.

export interface InstalledDep {
  ecosystem: "npm" | "rust";
  /** Package name as the advisory database spells it. */
  name: string;
  version: string;
  /** Absolute path of the file that declares it. */
  file: string;
  /** 0-based line in that file. */
  line: number;
  /** How it was found, for the view: "git submodule", "Soldeer", "npm", "Cargo.lock". */
  via: string;
}

export interface AdvisoryRange {
  ecosystem: string;
  package: string;
  range: string;
  fixed: string | null;
}

export interface Advisory {
  id: string;
  cve: string | null;
  title: string;
  severity: string;
  url: string;
  published: string | null;
  affected: AdvisoryRange[];
}

export interface AdvisoryData {
  source: string;
  generated: string;
  packages: string[];
  advisories: Advisory[];
}

export interface Hit {
  dep: InstalledDep;
  advisory: Advisory;
  range: string;
  fixed: string | null;
}

export function matchAdvisories(deps: InstalledDep[], data: AdvisoryData): Hit[] {
  const hits: Hit[] = [];
  for (const dep of deps) {
    for (const a of data.advisories) {
      for (const r of a.affected) {
        if (r.ecosystem !== dep.ecosystem || r.package !== dep.name) continue;
        if (inRange(dep.version, r.range)) {
          hits.push({ dep, advisory: a, range: r.range, fixed: r.fixed });
          break;
        }
      }
    }
  }
  return hits;
}

const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, moderate: 2, low: 3 };
export const bySeverity = (a: Hit, b: Hit) => (severityRank[a.advisory.severity] ?? 9) - (severityRank[b.advisory.severity] ?? 9);

// Ways to recognise a Solidity package that is not installed through npm.
const npmKnown = ["@openzeppelin/contracts", "@openzeppelin/contracts-upgradeable", "solady", "solmate"];
const repoNames: Record<string, string> = {
  "openzeppelin-contracts": "@openzeppelin/contracts",
  "openzeppelin-contracts-upgradeable": "@openzeppelin/contracts-upgradeable",
  solady: "solady",
  solmate: "solmate",
};
const soldeerNames: Record<string, string> = {
  "@openzeppelin-contracts": "@openzeppelin/contracts",
  "@openzeppelin-contracts-upgradeable": "@openzeppelin/contracts-upgradeable",
  solady: "solady",
  solmate: "solmate",
};
const rustKnown = ["anchor-lang", "anchor-spl", "solana-program", "spl-token", "spl-token-2022"];

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const readJson = (file: string): any => {
  const t = readText(file);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
const lineOf = (text: string, re: RegExp) => Math.max(0, text.split("\n").findIndex((l) => re.test(l)));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type GitDescribe = (dir: string) => Promise<string | undefined>;

export const gitDescribe: GitDescribe = async (dir) => {
  const r = await exec("git", ["describe", "--tags"], { cwd: dir, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
};

/** The package a checked-out Solidity library is, and its version from its own package.json if it has one. */
function identify(dir: string, hint: string): { name: string; version?: string } | undefined {
  // OpenZeppelin keeps the published name and version in contracts/package.json; the root one is "openzeppelin-solidity".
  for (const f of [path.join(dir, "contracts", "package.json"), path.join(dir, "package.json")]) {
    const pkg = readJson(f);
    if (pkg && npmKnown.includes(pkg.name)) return { name: pkg.name, version: pkg.version };
  }
  const name = repoNames[hint.toLowerCase()];
  if (!name) return undefined;
  const root = readJson(path.join(dir, "package.json"));
  return { name, version: typeof root?.version === "string" ? root.version : undefined };
}

interface Submodule {
  path: string;
  url: string;
  line: number;
}

export function parseGitmodules(text: string): Submodule[] {
  const out: Submodule[] = [];
  let cur: Submodule | undefined;
  text.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    if (l.startsWith("[submodule")) {
      cur = { path: "", url: "", line: i };
      out.push(cur);
    } else if (cur) {
      const m = l.match(/^(path|url)\s*=\s*(.+)$/);
      if (m) cur[m[1] as "path" | "url"] = m[2].trim();
    }
  });
  return out.filter((s) => s.path);
}

/** The [dependencies] table of foundry.toml: name → declared version and line. */
export function parseSoldeerDeps(toml: string): { name: string; version: string; line: number }[] {
  const out: { name: string; version: string; line: number }[] = [];
  let inDeps = false;
  toml.split("\n").forEach((raw, i) => {
    const l = raw.replace(/#.*$/, "").trim();
    if (l.startsWith("[")) {
      inDeps = l === "[dependencies]";
      return;
    }
    if (!inDeps) return;
    const m = l.match(/^"?([^"=\s]+)"?\s*=\s*(.+)$/);
    if (!m) return;
    const v = m[2].match(/^"([^"]+)"/) ?? m[2].match(/version\s*=\s*"([^"]+)"/);
    if (v) out.push({ name: m[1], version: v[1], line: i });
  });
  return out;
}

export async function foundryDeps(root: string, libs: string[], describe: GitDescribe = gitDescribe): Promise<InstalledDep[]> {
  const deps: InstalledDep[] = [];
  const seenDirs = new Set<string>();

  const gm = path.join(root, ".gitmodules");
  const gmText = readText(gm);
  if (gmText) {
    for (const s of parseGitmodules(gmText)) {
      const dir = path.join(root, s.path);
      seenDirs.add(path.resolve(dir));
      const hint = path.basename(s.url.replace(/\.git$/, "").replace(/\/$/, "")) || path.basename(s.path);
      const id = identify(dir, hint) ?? identify(dir, path.basename(s.path));
      if (!id) continue;
      const version = id.version ?? (await describe(dir));
      if (version) deps.push({ ecosystem: "npm", name: id.name, version, file: gm, line: s.line, via: "git submodule" });
    }
  }

  // Libraries copied into lib/ without a submodule: the declaration is their own package.json.
  for (const lib of libs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, lib), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.resolve(root, lib, e.name);
      if (!e.isDirectory() || seenDirs.has(dir)) continue;
      const id = identify(dir, e.name);
      if (!id?.version) continue;
      const file = fs.existsSync(path.join(dir, "contracts", "package.json")) ? path.join(dir, "contracts", "package.json") : path.join(dir, "package.json");
      deps.push({ ecosystem: "npm", name: id.name, version: id.version, file, line: lineOf(readText(file) ?? "", /"version"/), via: "lib folder" });
    }
  }

  // Soldeer: declared in foundry.toml, installed as dependencies/<name>-<version>.
  const tomlFile = path.join(root, "foundry.toml");
  const toml = readText(tomlFile) ?? "";
  const declared = parseSoldeerDeps(toml);
  const installed = new Map<string, string>();
  try {
    for (const d of fs.readdirSync(path.join(root, "dependencies"))) {
      for (const soldeer of Object.keys(soldeerNames)) {
        const rest = d.startsWith(soldeer + "-") ? d.slice(soldeer.length + 1) : "";
        // "@openzeppelin-contracts-upgradeable-5.0.2" also starts with "@openzeppelin-contracts-": the rest must be a version.
        if (/^\d/.test(rest)) installed.set(soldeer, rest);
      }
    }
  } catch {
    // no dependencies folder
  }
  for (const [soldeer, name] of Object.entries(soldeerNames)) {
    const decl = declared.find((d) => d.name === soldeer);
    const version = installed.get(soldeer) ?? decl?.version;
    if (version) deps.push({ ecosystem: "npm", name, version, file: tomlFile, line: decl?.line ?? 0, via: "Soldeer" });
  }

  deps.push(...npmDeps(root));
  return deps;
}

export function npmDeps(root: string): InstalledDep[] {
  const file = path.join(root, "package.json");
  const text = readText(file);
  const pkg = readJson(file);
  if (!text || !pkg) return [];
  const out: InstalledDep[] = [];
  for (const name of npmKnown) {
    const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
    if (typeof declared !== "string") continue;
    const installed = readJson(path.join(root, "node_modules", name, "package.json"))?.version;
    // Without node_modules only an exact version says what would be installed.
    const version = typeof installed === "string" ? installed : /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(declared) ? declared : undefined;
    if (version) out.push({ ecosystem: "npm", name, version, file, line: lineOf(text, new RegExp(`"${escape(name)}"\\s*:`)), via: "npm" });
  }
  return out;
}

export function parseCargoLock(text: string): { name: string; version: string; line: number }[] {
  const out: { name: string; version: string; line: number }[] = [];
  let cur: { name: string; version: string; line: number } | undefined;
  text.split("\n").forEach((raw, i) => {
    const l = raw.trim();
    if (l === "[[package]]") {
      cur = { name: "", version: "", line: i };
      out.push(cur);
      return;
    }
    const m = l.match(/^(name|version)\s*=\s*"([^"]+)"/);
    if (cur && m) {
      cur[m[1] as "name" | "version"] = m[2];
      if (m[1] === "name") cur.line = i;
    }
  });
  return out.filter((p) => p.name && p.version);
}

function cargoTomls(root: string): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!["target", "node_modules", ".git", ".anchor", "tests"].includes(e.name) && !e.name.startsWith(".")) visit(path.join(d, e.name), depth + 1);
      } else if (e.name === "Cargo.toml") out.push(path.join(d, e.name));
    }
  };
  visit(root, 0);
  return out.sort();
}

export function anchorDeps(root: string): InstalledDep[] {
  const lockFile = path.join(root, "Cargo.lock");
  const lock = readText(lockFile);
  if (!lock) return [];
  const tomls = cargoTomls(root).map((f) => ({ f, text: readText(f) ?? "" }));
  const out: InstalledDep[] = [];
  for (const p of parseCargoLock(lock)) {
    if (!rustKnown.includes(p.name)) continue;
    const decl = new RegExp(`^\\s*(${escape(p.name)}\\s*=|\\[(\\w+-)?dependencies\\.${escape(p.name)}\\])`);
    const declaring = tomls.filter((t) => t.text.split("\n").some((l) => decl.test(l)));
    if (declaring.length) {
      for (const t of declaring) out.push({ ecosystem: "rust", name: p.name, version: p.version, file: t.f, line: lineOf(t.text, decl), via: "Cargo.lock" });
    } else {
      // Only a dependency of a dependency: point at the lock file.
      out.push({ ecosystem: "rust", name: p.name, version: p.version, file: lockFile, line: p.line, via: "Cargo.lock" });
    }
  }
  return out;
}
