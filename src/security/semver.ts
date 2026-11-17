// Version comparison and the range syntax the GitHub Advisory Database uses: comma-separated constraints such as
// ">= 4.0.0, < 4.4.1", "= 4.9.4" or "< 1.0.2". Pre-releases sort before their release (5.0.0-rc.0 < 5.0.0).

export interface Version {
  nums: number[];
  pre: string[];
}

/** Parses "4.9.0", "v4.9.0", "4.9" or a git describe like "v4.9.0-12-gabc1234" (taken as 4.9.0). */
export function parseVersion(text: string): Version | undefined {
  const t = text
    .trim()
    .replace(/^v/i, "")
    .replace(/-\d+-g[0-9a-f]+$/, "")
    .replace(/\+.*$/, "");
  const m = t.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return undefined;
  return { nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ? m[4].split(".") : [] };
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] < b.nums[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** True when `version` is inside the range. An unreadable range or version never matches. */
export function inRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const parts = range.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    const m = p.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
    if (!m) return false;
    const bound = parseVersion(m[2]);
    if (!bound) return false;
    const c = compareVersions(v, bound);
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}
