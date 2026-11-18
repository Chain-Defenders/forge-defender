// Just enough TOML for Anchor.toml: tables, and keys with strings (multi-line ones too), numbers, booleans and
// single-line arrays. Anything else (inline tables, multi-line arrays) is kept as its raw text.

export type TomlValue = string | number | boolean | TomlValue[];
export type TomlTables = Map<string, Map<string, TomlValue>>;

export function parseToml(text: string): TomlTables {
  const tables: TomlTables = new Map([["", new Map()]]);
  let current = tables.get("")!;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const multi = /^\s*([^=#\[]+?)\s*=\s*("""|''')(.*)$/.exec(raw);
    if (multi && !multi[3].includes(multi[2])) {
      // A multi-line string: everything up to the closing delimiter, without the newline right after the opening.
      const body = [multi[3]];
      while (++n < lines.length && !lines[n].includes(multi[2])) body.push(lines[n]);
      if (n < lines.length) body.push(lines[n].slice(0, lines[n].indexOf(multi[2])));
      const value = body.join("\n").replace(/^\n/, "");
      current.set(unquoteKey(multi[1]), multi[2] === '"""' ? value.replace(/\\\s*\n\s*/g, "") : value);
      continue;
    }
    if (multi) {
      const inner = multi[3].slice(0, multi[3].indexOf(multi[2]));
      current.set(unquoteKey(multi[1]), inner);
      continue;
    }
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      const name = header[1].split(".").map(unquoteKey).join(".");
      current = tables.get(name) ?? new Map();
      tables.set(name, current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    current.set(unquoteKey(line.slice(0, eq).trim()), parseValue(line.slice(eq + 1).trim()));
  }
  return tables;
}

export function tomlString(tables: TomlTables, table: string, key: string): string | undefined {
  const v = tables.get(table)?.get(key);
  return typeof v === "string" ? v : undefined;
}

export function tomlNumber(tables: TomlTables, table: string, key: string): number | undefined {
  const v = tables.get(table)?.get(key);
  return typeof v === "number" ? v : undefined;
}

function unquoteKey(k: string): string {
  const t = k.trim();
  return /^".*"$|^'.*'$/.test(t) ? t.slice(1, -1) : t;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function parseValue(v: string): TomlValue {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c: string) => ({ n: "\n", t: "\t" })[c as "n" | "t"] ?? c);
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(v)) return Number(v.replace(/_/g, ""));
  if (v.startsWith("[") && v.endsWith("]")) {
    const items: TomlValue[] = [];
    const inner = v.slice(1, -1);
    let start = 0;
    let quote: string | undefined;
    let depth = 0;
    for (let i = 0; i <= inner.length; i++) {
      const c = inner[i];
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if ((c === "," && depth === 0) || i === inner.length) {
        const item = inner.slice(start, i).trim();
        if (item) items.push(parseValue(item));
        start = i + 1;
      }
    }
    return items;
  }
  return v;
}
