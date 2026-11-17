// A small Solidity reader: enough to find contracts, their bases and their functions with line numbers, without a
// compiler. Comments and strings are blanked out first (keeping offsets and line breaks), so braces and keywords
// inside them are never mistaken for code.

export type ContractKind = "contract" | "library" | "interface";

export interface SolFunction {
  name: string;
  /** 0-based line of the `function` keyword. */
  line: number;
  /** Offset of the `function` keyword in the source. */
  offset: number;
  /** Parameter list as written, without the brackets. */
  params: string;
  visibility: "public" | "external" | "internal" | "private" | "";
  mutability: "view" | "pure" | "payable" | "";
  /** Has `///` or `/** *\/` NatSpec directly above. */
  natspec: boolean;
  /** Offsets of the body's braces, when it has one. */
  bodyStart?: number;
  bodyEnd?: number;
}

export interface SolDeclaration {
  kind: "error" | "event";
  name: string;
  line: number;
  params: string;
}

export interface SolContract {
  name: string;
  kind: ContractKind;
  abstract: boolean;
  bases: string[];
  line: number;
  offset: number;
  /** Offsets of the body's `{` and `}`. */
  bodyStart: number;
  bodyEnd: number;
  functions: SolFunction[];
  declarations: SolDeclaration[];
}

export interface SolFile {
  contracts: SolContract[];
  /** Import paths as written. */
  imports: string[];
}

/** Blanks comments and string contents with spaces, keeping every newline and offset. */
export function blankCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

export function lineAt(src: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/** Offset of the bracket that closes the one at `open`, or -1. */
export function matchBracket(code: string, open: number): number {
  const o = code[open];
  const c = o === "{" ? "}" : o === "(" ? ")" : "]";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i;
  }
  return -1;
}

function hasNatspecAbove(src: string, offset: number): boolean {
  // Walk back over whitespace and attributes on earlier lines, then look for /// or a /** block.
  const before = src.slice(0, offset).replace(/[ \t]+$/, "");
  const lines = before.split("\n");
  lines.pop(); // the declaration's own line
  for (let k = lines.length - 1; k >= 0; k--) {
    const t = lines[k].trim();
    if (t === "") return false;
    if (t.startsWith("///")) return true;
    if (t.endsWith("*/")) {
      for (let m = k; m >= 0; m--) {
        if (lines[m].includes("/**")) return true;
        if (lines[m].includes("/*")) return false;
      }
      return false;
    }
    return false;
  }
  return false;
}

const contractRe = /\b(abstract\s+)?(contract|library|interface)\s+([A-Za-z_$][\w$]*)\s*(?:is\s+([^{]*))?\{/g;
const functionRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const declRe = /\b(error|event)\s+([A-Za-z_$][\w$]*)\s*\(/g;

export function parseSolidity(src: string): SolFile {
  const code = blankCommentsAndStrings(src);
  const contracts: SolContract[] = [];
  const imports: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["']/gm)) imports.push(m[1]);

  contractRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = contractRe.exec(code))) {
    const bodyStart = m.index + m[0].length - 1;
    const bodyEnd = matchBracket(code, bodyStart);
    if (bodyEnd === -1) break;
    const offset = m.index + (m[1]?.length ?? 0);
    const bases = (m[4] ?? "")
      .split(",")
      .map((b) => b.trim().replace(/\(.*$/s, "").trim())
      .filter(Boolean);
    const body = code.slice(bodyStart, bodyEnd);
    const functions: SolFunction[] = [];
    functionRe.lastIndex = 0;
    let f: RegExpExecArray | null;
    while ((f = functionRe.exec(body))) {
      const at = bodyStart + f.index;
      const open = bodyStart + f.index + f[0].length - 1;
      const close = matchBracket(code, open);
      if (close === -1) continue;
      // Header runs to the body's `{` or a `;`.
      let k = close + 1;
      while (k < bodyEnd && code[k] !== "{" && code[k] !== ";") k++;
      const header = code.slice(close + 1, k);
      const vis = header.match(/\b(public|external|internal|private)\b/)?.[1] ?? "";
      const mut = header.match(/\b(view|pure|payable)\b/)?.[1] ?? "";
      const fn: SolFunction = {
        name: f[1],
        line: lineAt(src, at),
        offset: at,
        params: src.slice(open + 1, close).replace(/\s+/g, " ").trim(),
        visibility: vis as SolFunction["visibility"],
        mutability: mut as SolFunction["mutability"],
        natspec: hasNatspecAbove(src, at),
      };
      if (code[k] === "{") {
        const end = matchBracket(code, k);
        fn.bodyStart = k;
        fn.bodyEnd = end;
        if (end !== -1) functionRe.lastIndex = end - bodyStart;
      }
      functions.push(fn);
    }
    const declarations: SolDeclaration[] = [];
    declRe.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(body))) {
      const open = bodyStart + d.index + d[0].length - 1;
      const close = matchBracket(code, open);
      if (close === -1) continue;
      declarations.push({
        kind: d[1] as "error" | "event",
        name: d[2],
        line: lineAt(src, bodyStart + d.index),
        params: src.slice(open + 1, close).replace(/\s+/g, " ").trim(),
      });
    }
    contracts.push({
      name: m[3],
      kind: m[2] as ContractKind,
      abstract: Boolean(m[1]),
      bases,
      line: lineAt(src, offset),
      offset,
      bodyStart,
      bodyEnd,
      functions,
      declarations,
    });
    contractRe.lastIndex = bodyEnd + 1;
  }
  // File-level errors and events (Solidity allows both) are attached to no contract; callers that need them can
  // parse again with a wrapper, which none do yet.
  return { contracts, imports };
}

/** Parameter types of a parameter list, without names and data locations: "uint256 a, bytes calldata b" → ["uint256", "bytes"]. */
export function paramTypes(params: string): string[] {
  if (!params.trim()) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of params) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((p) =>
    p
      .trim()
      .replace(/\s+(memory|calldata|storage|indexed|payable)\b/g, "")
      .replace(/\s+[A-Za-z_$][\w$]*$/, "")
      .trim(),
  );
}

/** Counts normalised source lines: not blank, not only a comment. Used for audit scope, the usual nSLOC. */
export function countNsloc(src: string): number {
  const code = blankCommentsAndStrings(src);
  // String contents are blanked, but a line holding only a string still has its quotes, so it counts.
  return code.split("\n").filter((l) => l.trim() !== "").length;
}
