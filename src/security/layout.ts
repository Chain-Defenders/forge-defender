// Storage layouts as `forge inspect <path>:<Name> storageLayout --json` prints them, and the comparison of an upgraded
// contract's layout against a saved baseline. Type ids carry AST ids that change between builds, so types are compared
// by what they are (label, size, members), never by id.

export interface LayoutEntry {
  label: string;
  slot: string;
  offset: number;
  type: string;
  astId?: number;
  contract?: string;
}

export interface LayoutType {
  encoding: string;
  label: string;
  numberOfBytes: string;
  members?: LayoutEntry[];
  key?: string;
  value?: string;
  base?: string;
}

export interface StorageLayout {
  storage: LayoutEntry[];
  types: Record<string, LayoutType> | null;
}

export interface Baseline {
  /** "src/Vault.sol:Vault" */
  contract: string;
  saved: string;
  layout: StorageLayout;
}

export function parseLayout(json: string): StorageLayout {
  const start = json.indexOf("{");
  if (start === -1) throw new Error("forge printed no storage layout");
  const d = JSON.parse(json.slice(start));
  if (!Array.isArray(d.storage)) throw new Error("forge printed no storage layout");
  return { storage: d.storage, types: d.types ?? {} };
}

/** The layout without AST ids and contract names, which change on every edit and would make the baseline noisy. */
export function stripLayout(l: StorageLayout): StorageLayout {
  const entry = (e: LayoutEntry): LayoutEntry => ({ label: e.label, slot: e.slot, offset: e.offset, type: e.type });
  const types: Record<string, LayoutType> = {};
  for (const [id, t] of Object.entries(l.types ?? {})) {
    types[id] = { ...t, ...(t.members ? { members: t.members.map(entry) } : {}) };
  }
  return { storage: l.storage.map(entry), types };
}

const typeOf = (l: StorageLayout, id: string): LayoutType | undefined => l.types?.[id];
const bytesOf = (l: StorageLayout, id: string) => Number(typeOf(l, id)?.numberOfBytes ?? 32);
const slotsOf = (l: StorageLayout, e: LayoutEntry) => BigInt(Math.max(1, Math.ceil((e.offset + bytesOf(l, e.type)) / 32)));

/** A readable type name: "struct Vault.Position" → "struct Position", "contract IERC20" → "IERC20". */
export function typeLabel(l: StorageLayout, id: string): string {
  const label = typeOf(l, id)?.label ?? id;
  return label.replace(/\b(struct|enum) [\w$]+\.([\w$]+)/g, "$1 $2");
}

export const isGap = (e: LayoutEntry) => /^_+gap$/i.test(e.label) || /^__gap/.test(e.label);

// Labels that mean the same bytes: contract and interface references are addresses.
function sameElementary(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .replace(/^contract [\w$]+$/, "address")
      .replace(/^address payable$/, "address")
      .replace(/\b(struct|enum) [\w$]+\.([\w$]+)/g, "$1 $2");
  return norm(a) === norm(b);
}

/**
 * Differences between two types, as short sentences. `growable` is true where a struct can gain members at the end
 * without moving anything else: as a mapping value.
 */
function typeDiffs(a: StorageLayout, aid: string, b: StorageLayout, bid: string, growable: boolean): string[] {
  const ta = typeOf(a, aid);
  const tb = typeOf(b, bid);
  if (!ta || !tb) return aid === bid ? [] : [`type changed from ${typeLabel(a, aid)} to ${typeLabel(b, bid)}`];
  const from = typeLabel(a, aid);
  const to = typeLabel(b, bid);
  if (ta.encoding !== tb.encoding) return [`type changed from ${from} to ${to}`];
  if (ta.encoding === "mapping") {
    if (!sameElementary(typeLabel(a, ta.key!), typeLabel(b, tb.key!))) return [`mapping key changed from ${typeLabel(a, ta.key!)} to ${typeLabel(b, tb.key!)}`];
    return typeDiffs(a, ta.value!, b, tb.value!, true);
  }
  if (ta.encoding === "dynamic_array") {
    // Elements sit back to back, so a struct element must keep its size too.
    return typeDiffs(a, ta.base!, b, tb.base!, false);
  }
  if (ta.members && tb.members) {
    const out: string[] = [];
    const name = from.replace(/^struct /, "");
    for (const m of ta.members) {
      const n = tb.members.find((x) => x.label === m.label);
      if (!n) {
        out.push(`struct ${name}: member ${m.label} removed`);
        continue;
      }
      if (n.slot !== m.slot || n.offset !== m.offset) out.push(`struct ${name}: member ${m.label} moved from slot ${m.slot} offset ${m.offset} to slot ${n.slot} offset ${n.offset}`);
      for (const d of typeDiffs(a, m.type, b, n.type, false)) out.push(`struct ${name}: member ${m.label}: ${d}`);
    }
    const aEnd = Math.max(0, ...ta.members.map((m) => Number(m.slot) * 32 + m.offset + bytesOf(a, m.type)));
    for (const n of tb.members) {
      if (ta.members.some((m) => m.label === n.label)) continue;
      const at = Number(n.slot) * 32 + n.offset;
      if (at < aEnd) out.push(`struct ${name}: member ${n.label} inserted before existing members`);
    }
    // Members added at the end are fine in a mapping value; stored inline or in an array, a bigger struct moves what follows.
    if (!growable && !out.length && ta.numberOfBytes !== tb.numberOfBytes) out.push(`struct ${name} grew from ${ta.numberOfBytes} to ${tb.numberOfBytes} bytes, which moves what is stored after it`);
    return out;
  }
  if (ta.base && tb.base) {
    // Fixed-size array: the length is in the label and the size.
    if (ta.numberOfBytes !== tb.numberOfBytes) return [`type changed from ${from} to ${to}`];
    return typeDiffs(a, ta.base, b, tb.base, false);
  }
  if (ta.numberOfBytes !== tb.numberOfBytes) return [`type changed from ${from} to ${to} (${ta.numberOfBytes} to ${tb.numberOfBytes} bytes)`];
  if (!sameElementary(ta.label, tb.label)) return [`type changed from ${from} to ${to}`];
  return [];
}

export interface LayoutIssue {
  kind: "removed" | "type" | "moved" | "inserted" | "renamed" | "gap";
  severity: "error" | "warning";
  label: string;
  message: string;
}

const slots = (n: bigint) => `${n} ${n === 1n ? "slot" : "slots"}`;
const pos = (e: LayoutEntry) => BigInt(e.slot) * 32n + BigInt(e.offset);

export function compareLayouts(base: StorageLayout, cur: StorageLayout): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const curByLabel = new Map(cur.storage.map((e) => [e.label, e]));
  const baseLabels = new Set(base.storage.map((e) => e.label));
  const added = cur.storage.filter((e) => !baseLabels.has(e.label));
  const renamedTo = new Set<LayoutEntry>();

  for (const b of base.storage) {
    const c = curByLabel.get(b.label);
    if (!c) {
      const same = added.find((n) => n.slot === b.slot && n.offset === b.offset && !renamedTo.has(n));
      if (same && !typeDiffs(base, b.type, cur, same.type, false).length) {
        renamedTo.add(same);
        issues.push({ kind: "renamed", severity: "warning", label: same.label, message: `${b.label} renamed to ${same.label}. The slot is unchanged, but check that the meaning is too.` });
      } else if (isGap(b)) {
        issues.push({ kind: "gap", severity: "error", label: b.label, message: `${b.label} removed: the ${slots(slotsOf(base, b))} it reserved now belong to whatever follows.` });
      } else {
        issues.push({ kind: "removed", severity: "error", label: b.label, message: `${b.label} removed from slot ${b.slot}. Keep it (renamed if you like) so later variables do not move.` });
      }
      continue;
    }
    if (isGap(b) && isGap(c)) {
      const bEnd = BigInt(b.slot) + slotsOf(base, b);
      const cEnd = BigInt(c.slot) + slotsOf(cur, c);
      if (bEnd !== cEnd) {
        const grew = BigInt(c.slot) - BigInt(b.slot);
        const shrank = slotsOf(base, b) - slotsOf(cur, c);
        issues.push({
          kind: "gap",
          severity: "error",
          label: b.label,
          message:
            shrank === 0n
              ? `${b.label} moved from slot ${b.slot} to slot ${c.slot}: storage after it moves too.`
              : `${b.label} shrank by ${slots(shrank)}, but the variables before it take ${grew}. It must end at slot ${bEnd}, not ${cEnd}.`,
        });
      }
      continue;
    }
    for (const d of typeDiffs(base, b.type, cur, c.type, false)) issues.push({ kind: "type", severity: "error", label: b.label, message: `${b.label}: ${d}.` });
    if (b.slot !== c.slot || b.offset !== c.offset) {
      issues.push({ kind: "moved", severity: "error", label: b.label, message: `${b.label} moved from slot ${b.slot} offset ${b.offset} to slot ${c.slot} offset ${c.offset}.` });
    }
  }

  // A new variable is safe after everything the baseline used, or inside a gap's old space (checked above). Anywhere
  // else it takes bytes an existing variable used.
  const used = base.storage.filter((b) => !isGap(b)).map((b) => ({ from: pos(b), to: pos(b) + BigInt(bytesOf(base, b.type)) }));
  for (const n of added) {
    if (renamedTo.has(n)) continue;
    const from = pos(n);
    const to = from + BigInt(bytesOf(cur, n.type));
    if (used.some((u) => from < u.to && u.from < to)) {
      issues.push({ kind: "inserted", severity: "error", label: n.label, message: `${n.label} inserted at slot ${n.slot}, where existing storage was. Add new variables after the existing ones.` });
    }
  }
  return issues;
}

/** Rows for the layout table: name, type, slot, offset, bytes. */
export function layoutRows(l: StorageLayout): { label: string; type: string; slot: string; offset: number; bytes: number }[] {
  return l.storage.map((e) => ({ label: e.label, type: typeLabel(l, e.type), slot: e.slot, offset: e.offset, bytes: bytesOf(l, e.type) }));
}

/** Struct members of the types used, for the table's detail rows. */
export function structRows(l: StorageLayout): { struct: string; members: { label: string; type: string; slot: string; offset: number }[] }[] {
  const out: { struct: string; members: { label: string; type: string; slot: string; offset: number }[] }[] = [];
  for (const [id, t] of Object.entries(l.types ?? {})) {
    if (!t.members) continue;
    out.push({ struct: typeLabel(l, id), members: t.members.map((m) => ({ label: m.label, type: typeLabel(l, m.type), slot: m.slot, offset: m.offset })) });
  }
  return out.sort((a, b) => a.struct.localeCompare(b.struct));
}

/** Contracts that look like an upgradeable implementation, and so deserve a baseline. */
export function looksUpgradeable(bases: string[], functionNames: string[], body: string): boolean {
  if (bases.some((b) => /^(Initializable|UUPSUpgradeable)$|Upgradeable$/.test(b))) return true;
  if (functionNames.includes("initialize") || functionNames.includes("upgradeToAndCall") || functionNames.includes("proxiableUUID")) return true;
  return /\b_disableInitializers\s*\(|\binitializer\b|\bERC1967Utils\b|\b__gap\b/.test(body);
}

/** Baseline path relative to the project root: .forgedefender/storage/src/Vault.sol/Vault.json */
export function baselinePath(source: string, name: string): string {
  return [".forgedefender", "storage", ...source.split(/[\\/]/), `${name}.json`].join("/");
}
