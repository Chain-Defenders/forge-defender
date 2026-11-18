// Finds mocha suites and tests in a TypeScript or JavaScript test file without running it: describe/context/suite
// and it/specify/test calls whose title is a plain string, nested by where their parentheses close. Titles built
// at run time are not known here; those tests appear once a run reports them.

export interface MochaNode {
  kind: "suite" | "test";
  title: string;
  /** 0-based. */
  line: number;
  col: number;
  modifier?: "skip" | "only";
  children: MochaNode[];
}

type Token =
  | { t: "id"; v: string; line: number; col: number }
  | { t: "str"; v: string; dynamic: boolean; line: number; col: number }
  | { t: "p"; v: string; line: number; col: number };

const suiteNames = new Set(["describe", "context", "suite", "xdescribe", "xcontext"]);
const testNames = new Set(["it", "specify", "test", "xit", "xspecify"]);

export function discoverMocha(source: string): MochaNode[] {
  const tokens = tokenize(source);
  const roots: MochaNode[] = [];
  const stack: { node: MochaNode; level: number }[] = [];
  const opens = new Map<number, MochaNode>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t === "p") {
      if (tok.v === "(" || tok.v === "[" || tok.v === "{") {
        depth++;
        const node = opens.get(i);
        if (node) stack.push({ node, level: depth });
      } else if (tok.v === ")" || tok.v === "]" || tok.v === "}") {
        depth--;
        while (stack.length && stack[stack.length - 1].level > depth) stack.pop();
      }
      continue;
    }
    if (tok.t !== "id" || (!suiteNames.has(tok.v) && !testNames.has(tok.v))) continue;
    const prev = tokens[i - 1];
    if (prev && prev.t === "p" && prev.v === ".") continue;
    let j = i + 1;
    let modifier: MochaNode["modifier"] = tok.v.startsWith("x") ? "skip" : undefined;
    const dot = tokens[j];
    const mod = tokens[j + 1];
    if (dot?.t === "p" && dot.v === "." && mod?.t === "id" && (mod.v === "skip" || mod.v === "only")) {
      modifier = mod.v;
      j += 2;
    }
    const open = tokens[j];
    const title = tokens[j + 1];
    if (open?.t !== "p" || open.v !== "(" || title?.t !== "str" || title.dynamic) continue;
    const after = tokens[j + 2];
    if (after?.t === "p" && after.v === ")" && !modifier) modifier = "skip"; // it("title") with no function is pending
    const node: MochaNode = { kind: suiteNames.has(tok.v) ? "suite" : "test", title: title.v, line: tok.line, col: tok.col, children: [] };
    if (modifier) node.modifier = modifier;
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    if (node.kind === "suite") opens.set(j, node);
  }
  return roots;
}

// After these, a slash starts a regular expression rather than a division.
const beforeRegex = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  const n = src.length;

  const newlinesIn = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (src[k] === "\n") {
        line++;
        lineStart = k + 1;
      }
    }
  };

  // Returns the index just past the closing quote, and the value with simple escapes resolved.
  const readString = (start: number): [number, string] => {
    const q = src[start];
    let v = "";
    let k = start + 1;
    while (k < n && src[k] !== q && src[k] !== "\n") {
      if (src[k] === "\\" && k + 1 < n) {
        const e = src[k + 1];
        v += e === "n" ? "\n" : e === "t" ? "\t" : e;
        k += 2;
      } else v += src[k++];
    }
    return [k + 1, v];
  };

  // Skips a template literal; reports whether it had ${} parts.
  const readTemplate = (start: number): [number, string, boolean] => {
    let k = start + 1;
    let v = "";
    let dynamic = false;
    while (k < n && src[k] !== "`") {
      if (src[k] === "\\") {
        v += src[k + 1] ?? "";
        k += 2;
      } else if (src[k] === "$" && src[k + 1] === "{") {
        dynamic = true;
        k = skipExpression(k + 2);
      } else v += src[k++];
    }
    return [k + 1, v, dynamic];
  };

  // From inside `${`, to just past the matching `}`.
  const skipExpression = (start: number): number => {
    let k = start;
    let braces = 1;
    while (k < n && braces > 0) {
      const c = src[k];
      if (c === "{") braces++;
      else if (c === "}") braces--;
      if (c === "'" || c === '"') k = readString(k)[0];
      else if (c === "`") k = readTemplate(k)[0];
      else k++;
    }
    return k;
  };

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      lineStart = ++i;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      newlinesIn(i, stop);
      i = stop;
      continue;
    }
    const col = i - lineStart;
    if (c === "'" || c === '"') {
      const [end, v] = readString(i);
      out.push({ t: "str", v, dynamic: false, line, col });
      i = end;
      continue;
    }
    if (c === "`") {
      const startLine = line;
      const [end, v, dynamic] = readTemplate(i);
      newlinesIn(i, end);
      out.push({ t: "str", v, dynamic, line: startLine, col });
      i = end;
      continue;
    }
    if (c === "/") {
      const prev = out[out.length - 1];
      const regex = !prev || (prev.t === "p" && beforeRegex.has(prev.v)) || (prev.t === "id" && /^(return|typeof|case|in|of)$/.test(prev.v));
      if (regex) {
        let k = i + 1;
        let cls = false;
        while (k < n && src[k] !== "\n") {
          if (src[k] === "\\") k++;
          else if (src[k] === "[") cls = true;
          else if (src[k] === "]") cls = false;
          else if (src[k] === "/" && !cls) break;
          k++;
        }
        i = k + 1;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        out.push({ t: "p", v: "regex", line, col });
        continue;
      }
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200));
    if (id) {
      out.push({ t: "id", v: id[0], line, col });
      i += id[0].length;
      continue;
    }
    out.push({ t: "p", v: c, line, col });
    i++;
  }
  return out;
}

/** "title path" as mocha's fullTitle() writes it. */
export function fullTitle(path: string[]): string {
  return path.join(" ");
}
