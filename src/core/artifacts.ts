import * as fs from "node:fs";
import * as path from "node:path";

// Compiled contracts in Foundry's out/ folder: out/<File>.sol/<Name>.json. Read lazily and cached by mtime, since
// a large project has thousands of them.

export interface AbiParam {
  name: string;
  type: string;
  internalType?: string;
  indexed?: boolean;
  components?: AbiParam[];
}

export interface AbiEntry {
  type: "function" | "event" | "error" | "constructor" | "fallback" | "receive";
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
  anonymous?: boolean;
}

export interface Artifact {
  name: string;
  /** Source path relative to the project root, from the compilation target. */
  source: string;
  abi: AbiEntry[];
  methodIdentifiers: Record<string, string>;
  /** Deployed bytecode as hex without 0x, possibly with link placeholders. */
  deployedBytecode: string;
  file: string;
}

const cache = new Map<string, { mtime: number; artifact: Artifact | undefined }>();

function readArtifact(file: string): Artifact | undefined {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.artifact;
  let artifact: Artifact | undefined;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const target = d.metadata?.settings?.compilationTarget ?? {};
    const [source, name] = Object.entries<string>(target)[0] ?? [];
    artifact = {
      name: name ?? path.basename(file, ".json"),
      source: source ?? "",
      abi: Array.isArray(d.abi) ? d.abi : [],
      methodIdentifiers: d.methodIdentifiers ?? {},
      deployedBytecode: String(d.deployedBytecode?.object ?? "").replace(/^0x/, ""),
      file,
    };
  } catch {
    artifact = undefined;
  }
  cache.set(file, { mtime, artifact });
  return artifact;
}

/** All artifacts under the project's out folder. Several contracts can share a name (in different files). */
export function listArtifacts(root: string, out = "out"): Artifact[] {
  const dir = path.join(root, out);
  const result: Artifact[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "build-info") continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(dir, e.name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const a = readArtifact(path.join(dir, e.name, f));
      if (a) result.push(a);
    }
  }
  return result;
}

export function findArtifact(root: string, name: string, source?: string, out = "out"): Artifact | undefined {
  const all = listArtifacts(root, out).filter((a) => a.name === name);
  return (source && all.find((a) => a.source === source)) || all[0];
}
