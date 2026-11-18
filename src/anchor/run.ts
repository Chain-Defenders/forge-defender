import { markerPrefix } from "./reporter";

// How `anchor test` is driven and read. anchor 0.31 appends its positional ARGS to the [scripts] test command and
// runs the result with `bash -c`. Its argument parser refuses values starting with "-", so the extra mocha options
// go in one argument that starts with a space; bash then splits it, which is also why every part is shell-quoted.

export interface TestResult {
  /** Suite titles then the test title, as mocha's titlePath(). For a failing hook: the suite's path. */
  path: string[];
  file?: string;
  state: "started" | "passed" | "failed" | "skipped";
  durationMs?: number;
  message?: string;
  stack?: string;
  expected?: string;
  actual?: string;
  /** A before/after hook failed: every test under `path` that has no result yet did not run. */
  hook?: string;
}

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The single positional argument for `anchor test`, or undefined when there is nothing to add. */
export function scriptArgs(parts: string[]): string | undefined {
  return parts.length ? " " + parts.map(shellQuote).join(" ") : undefined;
}

export function isMochaScript(script: string): boolean {
  return /(^|[\s/])(ts-)?_?mocha(\s|$)/.test(script);
}

const optionsWithValue = new Set(["-p", "--project", "-r", "--require", "--config", "--reporter", "-R", "-t", "--timeout", "--extension", "--ignore", "--grep", "-g", "--file"]);

/** The test file globs in a test script, e.g. "tests/**\/*.ts" from `yarn run ts-mocha -p ./tsconfig.json tests/**\/*.ts`. */
export function testScriptGlobs(script: string): string[] {
  const words = splitWords(script);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (optionsWithValue.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-") || w.includes("node_modules")) continue;
    if (/\*|\.(ts|js|mjs|cjs|tsx|jsx)$/.test(w) && /[/*]/.test(w)) out.push(w.replace(/^\.\//, ""));
  }
  return out;
}

function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c) || c === ";" || c === "&" || c === "|") {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over a relative path with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces) {
      braces--;
      re += ")";
    } else if (c === "," && braces) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A mocha --grep pattern selecting these items: a test by its exact full title, a suite by its title path as a
 * prefix. Mocha matches the pattern against each test's full title (titles joined by spaces).
 */
export function grepFor(items: { path: string[]; kind: "suite" | "test" }[]): string | undefined {
  if (!items.length) return undefined;
  const parts = items.map((i) => (i.kind === "test" ? `${escapeRegExp(i.path.join(" "))}$` : `${escapeRegExp(i.path.join(" "))} `));
  return `^(?:${[...new Set(parts)].join("|")})`;
}

export function parseMarker(line: string): TestResult | "end" | undefined {
  const at = line.indexOf(markerPrefix);
  if (at < 0) return undefined;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line.slice(at + markerPrefix.length));
  } catch {
    return undefined;
  }
  const path = Array.isArray(e.path) ? e.path.map(String) : [];
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const base = { path, file: str("file"), durationMs: typeof e.duration === "number" ? e.duration : undefined };
  switch (e.event) {
    case "start":
      return { ...base, state: "started" };
    case "pass":
      return { ...base, state: "passed" };
    case "pending":
      return { ...base, state: "skipped" };
    case "fail":
      return {
        ...base,
        state: "failed",
        message: str("message"),
        stack: str("stack"),
        expected: str("expected"),
        actual: str("actual"),
        hook: e.hook ? str("title") ?? "hook" : undefined,
      };
    case "end":
      return "end";
  }
  return undefined;
}

const passMark = /^( *)(?:✔|✓|√|ok) (.+?)(?: \((\d+)ms\))?$/;
const failMark = /^( *)(\d+)\) (.+)$/;
const pendingMark = /^( *)- (.+)$/;
const hookTitle = /^"(before|after) (all|each)" hook/;

/**
 * Reads mocha's spec reporter output, for scripts where our reporter could not be added. Suites are told apart from
 * other output by indentation only, so console output indented like a suite can end up in a title path.
 */
export function parseSpec(text: string): TestResult[] {
  const lines = text.split(/\r?\n/);
  const results: TestResult[] = [];
  const byNumber = new Map<number, TestResult>();
  const stack: { indent: number; title: string }[] = [];
  let i = 0;
  const pathAt = (indent: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack.map((s) => s.title);
  };
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");
    if (/^ {2}\d+ (passing|failing|pending)/.test(line)) break;
    let m: RegExpExecArray | null;
    if ((m = passMark.exec(line))) {
      results.push({ path: [...pathAt(m[1].length), m[2]], state: "passed", durationMs: m[3] ? Number(m[3]) : undefined });
    } else if ((m = failMark.exec(line)) && m[1].length >= 2) {
      const path = pathAt(m[1].length);
      const hook = hookTitle.test(m[3]) ? m[3] : undefined;
      const r: TestResult = hook ? { path, state: "failed", hook } : { path: [...path, m[3]], state: "failed" };
      results.push(r);
      byNumber.set(Number(m[2]), r);
    } else if ((m = pendingMark.exec(line)) && m[1].length >= 2) {
      results.push({ path: [...pathAt(m[1].length), m[2]], state: "skipped" });
    } else if (/^ {2,}\S/.test(line)) {
      const indent = line.length - line.trimStart().length;
      pathAt(indent);
      stack.push({ indent, title: line.trim() });
    }
  }
  // Failure details: "  1) suite\n       test:\n\n      message\n      at ...".
  let current: { r: TestResult; body: string[]; inTitle: boolean } | undefined;
  const flush = () => {
    if (!current) return;
    const body = current.body.join("\n").replace(/^\n+|\s+$/g, "");
    const at = body.search(/^\s*at /m);
    current.r.message = (at >= 0 ? body.slice(0, at) : body).split("\n").map((l) => l.trim()).join("\n").trim();
    if (at >= 0) current.r.stack = body.slice(at).split("\n").map((l) => l.trim()).join("\n").trim();
    current = undefined;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = /^ {2}(\d+)\) (.*)$/.exec(line);
    if (m && byNumber.has(Number(m[1]))) {
      flush();
      current = { r: byNumber.get(Number(m[1]))!, body: [], inTitle: !m[2].endsWith(":") };
      continue;
    }
    if (!current) continue;
    if (current.inTitle) {
      if (line.trimEnd().endsWith(":")) current.inTitle = false;
      continue;
    }
    if (/^(error Command failed|info Visit|npm ERR!)/.test(line)) {
      flush();
      continue;
    }
    current.body.push(line);
  }
  flush();
  return results;
}

/** Where the stack trace says the failure happened in `file`: 0-based line and column. */
export function stackLocation(stack: string | undefined, file: string): { line: number; col: number } | undefined {
  if (!stack) return undefined;
  for (const m of stack.matchAll(/(?:\(|at )((?:[A-Za-z]:)?[^():\s]+):(\d+):(\d+)\)?/g)) {
    if (m[1] === file || file.endsWith("/" + m[1].replace(/^\.\//, ""))) return { line: Number(m[2]) - 1, col: Number(m[3]) - 1 };
  }
  return undefined;
}

/** A clear reason for a run that failed before any test ran, from anchor's own messages. */
export function runProblem(output: string): string | undefined {
  let m: RegExpExecArray | null;
  if ((m = /Your configured (rpc|faucet) port: (\d+) is already in use/.exec(output))) {
    return `Port ${m[2]} is already in use, usually by a solana-test-validator left running from an earlier run. Stop it (for example with Ctrl+C in its terminal) and run the tests again.`;
  }
  if (/Unable to get latest blockhash\. Test validator does not look started/.test(output)) {
    return "The local validator did not start in time. See .anchor/test-ledger/test-ledger-log.txt, or raise [test] startup_wait in Anchor.toml.";
  }
  if (/Failed to spawn `solana-test-validator`/.test(output)) return "solana-test-validator could not be started. Is the Solana CLI installed and on the PATH?";
  if (/error: could not compile|error\[E\d+\]/.test(output)) return "The program did not build. See the test output for the compiler errors.";
  return undefined;
}
