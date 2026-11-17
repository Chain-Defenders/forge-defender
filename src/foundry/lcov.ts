// Reads the lcov file `forge coverage --report lcov` writes.

export interface LcovFile {
  /** Path as written by forge, usually relative to the project root. */
  file: string;
  lines: Map<number, number>; // 1-based line → hits
  functions: { name: string; line: number; hits: number }[];
  branches: { line: number; block: string; branch: string; hits: number }[];
}

export type Lcov = LcovFile[];

export function parseLcov(text: string): Lcov {
  const files: LcovFile[] = [];
  let cur: LcovFile | undefined;
  const fnLines = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(":");
    const tag = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? "" : line.slice(colon + 1);
    switch (tag) {
      case "SF":
        cur = { file: rest, lines: new Map(), functions: [], branches: [] };
        fnLines.clear();
        files.push(cur);
        break;
      case "DA": {
        if (!cur) break;
        const [ln, hits] = rest.split(",");
        const n = Number(ln);
        cur.lines.set(n, (cur.lines.get(n) ?? 0) + Number(hits));
        break;
      }
      case "FN": {
        const [ln, ...name] = rest.split(",");
        fnLines.set(name.join(","), Number(ln));
        break;
      }
      case "FNDA": {
        if (!cur) break;
        const [hits, ...name] = rest.split(",");
        const n = name.join(",");
        cur.functions.push({ name: n, line: fnLines.get(n) ?? 0, hits: Number(hits) });
        break;
      }
      case "BRDA": {
        if (!cur) break;
        const [ln, block, branch, hits] = rest.split(",");
        cur.branches.push({ line: Number(ln), block, branch, hits: hits === "-" ? 0 : Number(hits) });
        break;
      }
      case "end_of_record":
        cur = undefined;
        break;
    }
  }
  return files;
}

export interface CoverageSummary {
  lines: { hit: number; total: number };
  functions: { hit: number; total: number };
  branches: { hit: number; total: number };
}

export function summarize(files: LcovFile[]): CoverageSummary {
  const s: CoverageSummary = { lines: { hit: 0, total: 0 }, functions: { hit: 0, total: 0 }, branches: { hit: 0, total: 0 } };
  for (const f of files) {
    for (const hits of f.lines.values()) {
      s.lines.total++;
      if (hits > 0) s.lines.hit++;
    }
    for (const fn of f.functions) {
      s.functions.total++;
      if (fn.hits > 0) s.functions.hit++;
    }
    for (const b of f.branches) {
      s.branches.total++;
      if (b.hits > 0) s.branches.hit++;
    }
  }
  return s;
}

export function percent(x: { hit: number; total: number }): number {
  return x.total === 0 ? 100 : (100 * x.hit) / x.total;
}
