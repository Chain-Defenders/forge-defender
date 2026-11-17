import { parseSolidity, countNsloc, blankCommentsAndStrings, lineAt } from "../core/solidity";
import { summarize, type CoverageSummary, type Lcov } from "../foundry/lcov";

// The audit readiness report: what an auditor asks for first, worked out from the sources, coverage and the last test
// run. Pure, so the numbers can be tested without an editor; readiness.ts renders and shows it.

export interface SourceFile {
  /** Relative to the project root, with forward slashes. */
  rel: string;
  text: string;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  at: string;
}

export interface Place {
  file: string;
  /** 1-based. */
  line: number;
  text: string;
}

export interface ReadinessReport {
  project: string;
  scope: { file: string; nsloc: number }[];
  interfaces: { file: string; nsloc: number }[];
  mocks: { file: string; nsloc: number }[];
  nsloc: number;
  coverage?: CoverageSummary;
  missingNatspec: Place[];
  unexecuted: Place[];
  floatingPragmas: Place[];
  todos: Place[];
  tests?: TestCounts;
  /** Shown when the project fits the open audit grant. */
  grant?: { url: string; closes: string; maxNsloc: number };
  estimateUrl: string;
}

export const GRANT = { maxNsloc: 4000, lastDay: "2026-12-15", closes: "15 December 2026" };

export function isMock(rel: string, text: string): boolean {
  if (/(^|\/)(mocks?|test|tests|testing)\//i.test(rel) || /(^|\/)Mock[\w]*\.sol$|Mock\.sol$/i.test(rel)) return true;
  const contracts = parseSolidity(text).contracts;
  return contracts.length > 0 && contracts.every((c) => /^Mock|Mock$/.test(c.name));
}

export function isInterfaceFile(rel: string, text: string): boolean {
  if (/(^|\/)interfaces?\//i.test(rel)) return true;
  const contracts = parseSolidity(text).contracts;
  return contracts.length > 0 && contracts.every((c) => c.kind === "interface");
}

export function floatingPragmas(rel: string, text: string): Place[] {
  const out: Place[] = [];
  const code = blankCommentsAndStrings(text);
  for (const m of code.matchAll(/\bpragma\s+solidity\s+([^;]+);/g)) {
    const spec = m[1].trim();
    // Exact: "0.8.24" or "=0.8.24". Anything else lets the compiler version float.
    if (!/^=?\s*\d+\.\d+\.\d+$/.test(spec)) out.push({ file: rel, line: lineAt(text, m.index) + 1, text: `pragma solidity ${spec}` });
  }
  return out;
}

export function todos(rel: string, text: string): Place[] {
  const out: Place[] = [];
  text.split("\n").forEach((l, i) => {
    const m = l.match(/\b(TODO|FIXME)\b.*/);
    if (m) out.push({ file: rel, line: i + 1, text: m[0].trim().slice(0, 120) });
  });
  return out;
}

export function missingNatspec(rel: string, text: string): Place[] {
  const out: Place[] = [];
  for (const c of parseSolidity(text).contracts) {
    for (const f of c.functions) {
      if ((f.visibility === "public" || f.visibility === "external") && !f.natspec) out.push({ file: rel, line: f.line + 1, text: `${c.name}.${f.name}` });
    }
  }
  return out;
}

const normalise = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

export function buildReport(input: {
  project: string;
  files: SourceFile[];
  lcov?: Lcov;
  tests?: TestCounts;
  today: Date;
  grantUrl: string;
  estimateUrl: string;
}): ReadinessReport {
  const scope: ReadinessReport["scope"] = [];
  const interfaces: ReadinessReport["interfaces"] = [];
  const mocks: ReadinessReport["mocks"] = [];
  const r: ReadinessReport = { project: input.project, scope, interfaces, mocks, nsloc: 0, missingNatspec: [], unexecuted: [], floatingPragmas: [], todos: [], tests: input.tests, estimateUrl: input.estimateUrl };
  const inScope: SourceFile[] = [];
  for (const f of input.files) {
    const row = { file: f.rel, nsloc: countNsloc(f.text) };
    if (isMock(f.rel, f.text)) mocks.push(row);
    else if (isInterfaceFile(f.rel, f.text)) interfaces.push(row);
    else {
      scope.push(row);
      inScope.push(f);
    }
  }
  r.nsloc = scope.reduce((s, f) => s + f.nsloc, 0);
  for (const f of inScope) {
    r.missingNatspec.push(...missingNatspec(f.rel, f.text));
    r.floatingPragmas.push(...floatingPragmas(f.rel, f.text));
    r.todos.push(...todos(f.rel, f.text));
  }
  if (input.lcov) {
    const names = new Set(inScope.map((f) => normalise(f.rel)));
    const covered = input.lcov.filter((l) => names.has(normalise(l.file)));
    r.coverage = summarize(covered);
    for (const l of covered) {
      for (const fn of l.functions) {
        if (fn.hits === 0) r.unexecuted.push({ file: normalise(l.file), line: fn.line, text: fn.name });
      }
    }
  }
  const d = input.today;
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (scope.length && r.nsloc <= GRANT.maxNsloc && today <= GRANT.lastDay) r.grant = { url: input.grantUrl, closes: GRANT.closes, maxNsloc: GRANT.maxNsloc };
  return r;
}

const pct = (x: { hit: number; total: number }) => (x.total === 0 ? "n/a" : `${((100 * x.hit) / x.total).toFixed(1)}%`);

export function coverageLine(c: CoverageSummary): string {
  return `Lines ${pct(c.lines)} (${c.lines.hit}/${c.lines.total}), branches ${pct(c.branches)} (${c.branches.hit}/${c.branches.total}), functions ${pct(c.functions)} (${c.functions.hit}/${c.functions.total})`;
}

export const coveragePercent = pct;

/** scope.txt: one in-scope file per line, as auditors expect it. */
export function scopeText(r: ReadinessReport): string {
  return r.scope.map((f) => f.file).join("\n") + "\n";
}
