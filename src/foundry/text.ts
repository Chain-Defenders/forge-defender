import { stripAnsi } from "../core/exec";

// forge output that has no JSON form: compiler errors, and the test results `forge coverage` prints.

export interface CompilerMessage {
  severity: "error" | "warning";
  code?: string;
  message: string;
  /** Path as printed, relative to the project root. */
  file: string;
  /** 1-based. */
  line: number;
  column: number;
}

/**
 *   Error (6933): Expected primary expression.
 *     --> src/Counter.sol:32:50:
 */
export function parseCompilerMessages(output: string): CompilerMessage[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const out: CompilerMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(Error|Warning)(?: \((\d+)\))?: (.*)$/);
    if (!head) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      // "Error: Compiler run failed:" heads the list; its location is the next message's.
      if (/^(Error|Warning)\b/.test(lines[j])) break;
      const at = lines[j].match(/^\s*-->\s+(.+?):(\d+):(\d+):?\s*$/);
      if (at) {
        out.push({
          severity: head[1] === "Error" ? "error" : "warning",
          code: head[2],
          message: head[3].trim(),
          file: at[1],
          line: Number(at[2]),
          column: Number(at[3]),
        });
        break;
      }
    }
  }
  return out;
}

export interface TextOutcome {
  file: string;
  contract: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
}

/** Index of the bracket closing the one at `open`, counting nested square brackets. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Reads `Ran N tests for path:Contract` headers and the `[PASS]` / `[FAIL: reason]` / `[SKIP]` lines under them.
 * An invariant failure prints its call sequence between the bracket and the test name, over several lines.
 */
export function parseTextResults(output: string): TextOutcome[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const out: TextOutcome[] = [];
  let suite: { file: string; contract: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    // The summary at the end repeats every failure.
    if (/^Failing tests:/.test(lines[i])) break;
    const header = lines[i].match(/^Ran \d+ tests? for (.+):([A-Za-z_$][\w$]*)\s*$/);
    if (header) {
      suite = { file: header[1], contract: header[2] };
      continue;
    }
    if (!suite || !/^\[(PASS|FAIL|SKIP)/.test(lines[i])) continue;
    // Join the following lines until the test name appears, for multi-line failures.
    let text = lines[i];
    let j = i;
    while (closeOf(text, 0) === -1 && j + 1 < lines.length) text += "\n" + lines[++j];
    const end = closeOf(text, 0);
    if (end === -1) continue;
    // The name follows the bracket on the same line, or (after a call sequence) starts a later line of its own.
    const testLine = /^\s*([A-Za-z_$][\w$]*)\([^()]*\)\s*(\(|$)/;
    let name = text.slice(end + 1).match(testLine)?.[1];
    while (!name && j + 1 < lines.length && j - i < 200) {
      const next = lines[++j];
      if (/^\[(PASS|FAIL|SKIP)|^Suite result/.test(next)) {
        j--;
        break;
      }
      if (!/=/.test(next)) name = next.match(testLine)?.[1];
    }
    if (!name) continue;
    const tag = text.slice(1, end);
    const status = tag.startsWith("PASS") ? "passed" : tag.startsWith("SKIP") ? "skipped" : "failed";
    const reason = tag.startsWith("FAIL") ? tag.replace(/^FAIL:?\s*/, "").trim() || undefined : undefined;
    out.push({ ...suite, name, status, reason });
    i = j;
  }
  return out;
}
