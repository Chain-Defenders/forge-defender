// Gas against the last `forge snapshot`. The snapshot file has one line per test:
//   CounterTest:test_Increment() (gas: 51891)
//   CounterTest:testFuzz_Set(uint256) (runs: 256, μ: 30521, ~: 31289)

export interface SnapshotEntry {
  gas: number;
  /** "gas" for unit tests, "mean gas" for fuzz tests (the μ value). */
  label: string;
}

/** Keyed by "Contract:signature". */
export function parseSnapshot(text: string): Map<string, SnapshotEntry> {
  const out = new Map<string, SnapshotEntry>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S+?:\S+\(.*?\))\s+\((.*)\)\s*$/);
    if (!m) continue;
    const unit = m[2].match(/^gas:\s*(\d+)/);
    const fuzz = m[2].match(/μ:\s*(\d+)/);
    if (unit) out.set(m[1], { gas: Number(unit[1]), label: "gas" });
    else if (fuzz) out.set(m[1], { gas: Number(fuzz[1]), label: "mean gas" });
  }
  return out;
}

export interface GasChange {
  gas: number;
  before?: number;
  /** Positive when more expensive. */
  delta?: number;
  percent?: number;
}

export function gasChange(gas: number, before: SnapshotEntry | undefined): GasChange {
  if (!before) return { gas };
  const delta = gas - before.gas;
  return { gas, before: before.gas, delta, percent: before.gas ? (100 * delta) / before.gas : undefined };
}

const fmt = new Intl.NumberFormat("en-US");

/** "51,891 gas", "51,891 gas (+312, +0.6%)". */
export function describeGas(c: GasChange, label = "gas"): string {
  const base = `${fmt.format(c.gas)} ${label}`;
  if (c.delta === undefined || c.delta === 0) return base;
  const sign = c.delta > 0 ? "+" : "−";
  const pct = c.percent === undefined ? "" : `, ${sign}${Math.abs(c.percent).toFixed(1)}%`;
  return `${base} (${sign}${fmt.format(Math.abs(c.delta))}${pct})`;
}
