import * as path from "node:path";

// Reading keymoat's output: `doctor --json` (or the plain text of keymoat versions before it), `scan --json` and
// `log --json`. keymoat never prints a key's value, so nothing read here holds one.

export interface DoctorTool {
  name: string;
  through: boolean;
  /** Where the name resolves on the PATH; empty when the tool is not installed. */
  found: string;
  real?: string;
}

export interface PlainKey {
  file: string;
  line?: number;
  name?: string;
  kind: string;
  fix: string;
}

export interface Doctor {
  sandbox: { ok: boolean; detail: string };
  tools: DoctorTool[];
  pathFirst?: boolean;
  shimDir?: string;
  project?: string;
  plainKeys: PlainKey[];
  /** Read from the text of a keymoat without `doctor --json`. */
  legacy: boolean;
}

export function parseDoctorJson(stdout: string): Doctor {
  const d = JSON.parse(stdout);
  return {
    sandbox: { ok: Boolean(d.sandbox?.ok), detail: String(d.sandbox?.detail ?? "") },
    tools: (Array.isArray(d.tools) ? d.tools : []).map((t: DoctorTool) => ({
      name: String(t.name),
      through: Boolean(t.through),
      found: String(t.found ?? ""),
      real: t.real,
    })),
    pathFirst: typeof d.pathFirst === "boolean" ? d.pathFirst : undefined,
    shimDir: typeof d.shimDir === "string" ? d.shimDir : undefined,
    project: typeof d.project === "string" ? d.project : undefined,
    plainKeys: parseFindings(d.plainKeys),
    legacy: false,
  };
}

/** Plain `keymoat doctor` text, as printed by 0.1.0: sections of "✓"/"✗" lines. */
export function parseDoctorText(stdout: string, project?: string): Doctor {
  const doc: Doctor = { sandbox: { ok: false, detail: "" }, tools: [], plainKeys: [], legacy: true };
  let section = "";
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      section = raw.trim();
      continue;
    }
    const m = raw.match(/^\s+([✓✗])\s+(.*)$/);
    if (m) {
      const ok = m[1] === "✓";
      const text = m[2];
      if (section === "Sandbox") doc.sandbox = { ok, detail: text };
      else if (section === "Tools") {
        let t: RegExpMatchArray | null;
        if ((t = text.match(/^(\S+)\s+goes through keymoat\s+\(the tool itself: (.*)\)$/))) doc.tools.push({ name: t[1], through: true, found: "", real: t[2] });
        else if ((t = text.match(/^(\S+)\s+runs directly from (.*), not through keymoat$/))) doc.tools.push({ name: t[1], through: false, found: t[2] });
        else if ((t = text.match(/^(\S+): not found on the PATH$/))) doc.tools.push({ name: t[1], through: false, found: "" });
      } else if (section.startsWith("Keys") && !ok) {
        let k: RegExpMatchArray | null;
        if ((k = text.match(/^(.*) is a (.*) in plain text: `(.*)`$/))) doc.plainKeys.push({ file: k[1], kind: k[2], fix: k[3] });
        else if ((k = text.match(/^(.*) line (\d+): (.*) \((.*)\): `(.*)`$/))) {
          doc.plainKeys.push({ file: project ? path.resolve(project, k[1]) : k[1], line: Number(k[2]), name: k[3], kind: k[4], fix: k[5] });
        }
      }
      continue;
    }
    const p = raw.match(/^\s+(\S+) is not first on the PATH/);
    if (p) {
      doc.shimDir = p[1];
      doc.pathFirst = false;
    }
  }
  if (doc.tools.length && doc.pathFirst === undefined) doc.pathFirst = true;
  return doc;
}

function parseFindings(list: unknown): PlainKey[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.file === "string")
    .map((f) => {
      const k: PlainKey = { file: f.file, kind: String(f.kind ?? "key"), fix: String(f.fix ?? "") };
      if (typeof f.line === "number" && f.line > 0) k.line = f.line;
      if (typeof f.name === "string" && f.name) k.name = f.name;
      return k;
    });
}

/** `keymoat scan --json` output. Exit code 0: none found, 1: found (the JSON lists them), anything else: failed. */
export function parseScan(stdout: string, code: number | null): PlainKey[] {
  if (code !== 0 && code !== 1) throw new Error(`keymoat scan failed (exit code ${code})`);
  return parseFindings(JSON.parse(stdout));
}

export function mergeKeys(...lists: PlainKey[][]): PlainKey[] {
  const seen = new Set<string>();
  const out: PlainKey[] = [];
  for (const k of lists.flat()) {
    const id = `${k.file}:${k.line ?? 0}:${k.name ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(k);
  }
  return out;
}

export interface KeymoatEvent {
  time: string;
  kind: string;
  tool?: string;
  project?: string;
  detail?: string;
}

export function parseLog(stdout: string): KeymoatEvent[] {
  const out: KeymoatEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.kind === "string" && typeof e.time === "string") out.push(e);
    } catch {
      // a line keymoat could not write whole; skip it
    }
  }
  return out;
}

export interface BlockedHost {
  host: string;
  /** keymoat's project folder for the event: `keymoat allow` must run there to apply to the same project. */
  project: string;
  tool?: string;
  last: string;
  count: number;
}

const within = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/**
 * Hosts blocked for these project folders, newest first, one entry per host and project. keymoat's project folder is
 * the git root, so it can be above a Foundry or Anchor project in a monorepo, or below a workspace folder.
 */
export function blockedHosts(events: KeymoatEvent[], roots: string[], allowed: (host: string, project: string) => boolean = () => false): BlockedHost[] {
  const map = new Map<string, BlockedHost>();
  for (const e of events) {
    if (e.kind !== "blocked-host" || !e.project || !e.detail) continue;
    const project = e.project;
    if (!roots.some((r) => within(project, r) || within(r, project))) continue;
    if (allowed(e.detail, project)) continue;
    const id = `${project}\n${e.detail}`;
    const b = map.get(id);
    if (b) {
      b.count++;
      if (e.time > b.last) b.last = e.time;
    } else map.set(id, { host: e.detail, project, tool: e.tool, last: e.time, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** keymoat's host matching: an exact host, or "*.example.com" for example.com and everything under it. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    if (q.startsWith("*.")) return h === q.slice(2) || h.endsWith(q.slice(1));
    return h === q;
  });
}

/** Hosts keymoat's settings already allow, globally or for a project (~/.keymoat/config.json). */
export function allowedFromConfig(configJson: string): (host: string, project: string) => boolean {
  let cfg: { allowHosts?: string[]; projects?: Record<string, { hosts?: string[] }> } = {};
  try {
    cfg = JSON.parse(configJson);
  } catch {
    return () => false;
  }
  return (host, project) => hostAllowed(host, [...(cfg.allowHosts ?? []), ...(cfg.projects?.[project]?.hosts ?? [])]);
}

/** Tools the extension and the tools it starts run: these must go through keymoat for editor runs to be sandboxed. */
export const editorTools = ["forge", "cast", "anchor", "cargo", "solana", "npm", "npx", "yarn", "pnpm", "bun"];
