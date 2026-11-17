import { parseSolidity, SolContract, SolFile } from "../core/solidity";

// Finds tests from the source, so the tree is there before anything compiles. A test contract inherits the tests of
// its bases; those are shown under the contract that runs them, pointing at the line where they are written.

export interface DiscoveredTest {
  name: string;
  /** Where the function is written: the contract's own file or a base's. */
  file: string;
  line: number;
  kind: "unit" | "fuzz" | "invariant";
  /** Name of the base contract it comes from, when inherited. */
  inheritedFrom?: string;
}

export interface DiscoveredContract {
  name: string;
  file: string;
  line: number;
  tests: DiscoveredTest[];
}

export function isTestFunction(name: string): boolean {
  return /^(test|invariant|statefulFuzz)/.test(name);
}

function testKind(name: string, params: string): DiscoveredTest["kind"] {
  if (/^(invariant|statefulFuzz)/.test(name)) return "invariant";
  return params.trim() ? "fuzz" : "unit";
}

/** `files` maps a file path to its parsed source. Returns the runnable test contracts, by file. */
export function discoverTests(files: Map<string, SolFile>): Map<string, DiscoveredContract[]> {
  const byName = new Map<string, { file: string; contract: SolContract }>();
  for (const [file, parsed] of files) {
    for (const c of parsed.contracts) if (!byName.has(c.name)) byName.set(c.name, { file, contract: c });
  }

  const testsOf = (start: string, startFile: string): DiscoveredTest[] => {
    const found = new Map<string, DiscoveredTest>();
    const seen = new Set<string>();
    // Solidity's linearisation puts the most derived first; walking own functions, then bases breadth-first, keeps
    // the most derived definition of each name, which is the one that runs.
    const queue: { name: string; file?: string; inherited: boolean }[] = [{ name: start, file: startFile, inherited: false }];
    while (queue.length) {
      const { name, file, inherited } = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const own = file ? files.get(file)?.contracts.find((c) => c.name === name) : undefined;
      const entry = own ? { file: file!, contract: own } : byName.get(name);
      if (!entry) continue;
      for (const f of entry.contract.functions) {
        if (!isTestFunction(f.name) || found.has(f.name)) continue;
        if (f.visibility !== "public" && f.visibility !== "external") continue;
        found.set(f.name, {
          name: f.name,
          file: entry.file,
          line: f.line,
          kind: testKind(f.name, f.params),
          inheritedFrom: inherited ? entry.contract.name : undefined,
        });
      }
      for (const b of entry.contract.bases) queue.push({ name: b, inherited: true });
    }
    return [...found.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.inheritedFrom ? 1 : -1));
  };

  const out = new Map<string, DiscoveredContract[]>();
  for (const [file, parsed] of files) {
    const contracts: DiscoveredContract[] = [];
    for (const c of parsed.contracts) {
      if (c.kind !== "contract" || c.abstract) continue;
      const tests = testsOf(c.name, file);
      if (tests.length) contracts.push({ name: c.name, file, line: c.line, tests });
    }
    if (contracts.length) out.set(file, contracts);
  }
  return out;
}

export function parseAll(sources: Map<string, string>): Map<string, SolFile> {
  const parsed = new Map<string, SolFile>();
  for (const [file, src] of sources) parsed.set(file, parseSolidity(src));
  return parsed;
}
