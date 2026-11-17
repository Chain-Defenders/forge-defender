// Reads `forge test --json`. One object per suite ("path:Contract"), each with test results keyed by signature.

export interface CallStep {
  sender: string;
  addr: string;
  calldata: string;
  signature?: string;
  contractName?: string;
  args?: string;
  warp?: string;
  roll?: string;
}

export type Counterexample =
  | { kind: "single"; calldata: string; args: string; signature?: string }
  | { kind: "sequence"; calls: CallStep[] };

export interface InvariantFailure {
  name: string;
  reason: string;
  calls: CallStep[];
}

export interface TestOutcome {
  /** Function name without parameters. */
  name: string;
  /** As forge prints it: name with parameter types. */
  signature: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  gas?: number;
  /** "gas" for a unit test, "mean gas" for a fuzz test. */
  gasLabel?: string;
  durationMs?: number;
  counterexample?: Counterexample;
  invariantFailures: InvariantFailure[];
  logs: string[];
  kind: "unit" | "fuzz" | "invariant" | "other";
  fuzzRuns?: number;
}

export interface SuiteResult {
  /** Path as forge prints it, relative to the project root. */
  file: string;
  contract: string;
  durationMs?: number;
  tests: TestOutcome[];
  warnings: string[];
}

/** "5ms 790µs 416ns", "1s 20ms", "23µs 708ns" → milliseconds. */
export function parseDuration(s: unknown): number | undefined {
  if (typeof s === "number") return s;
  if (typeof s !== "string") {
    // Older forge printed { secs, nanos }.
    if (s && typeof s === "object" && "secs" in s) {
      const d = s as { secs: number; nanos: number };
      return d.secs * 1000 + d.nanos / 1e6;
    }
    return undefined;
  }
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, "µs": 1e-3, us: 1e-3, ns: 1e-6 };
  let total = 0;
  let any = false;
  for (const m of s.matchAll(/([\d.]+)\s*(h|ms|µs|us|ns|m|s)\b/g)) {
    total += parseFloat(m[1]) * units[m[2]];
    any = true;
  }
  return any ? total : undefined;
}

function step(raw: any): CallStep {
  return {
    sender: raw.sender ?? "",
    addr: raw.addr ?? "",
    calldata: raw.calldata ?? "0x",
    signature: raw.signature ?? undefined,
    contractName: raw.contract_name ?? undefined,
    args: raw.args ?? undefined,
    warp: raw.warp ?? undefined,
    roll: raw.roll ?? undefined,
  };
}

function counterexample(raw: any): Counterexample | undefined {
  if (!raw) return undefined;
  if (raw.Single) return { kind: "single", calldata: raw.Single.calldata, args: raw.Single.args ?? "", signature: raw.Single.signature ?? undefined };
  if (raw.Sequence) {
    // Newer forge: [originalLength, calls]; older: calls.
    const calls = Array.isArray(raw.Sequence[1]) ? raw.Sequence[1] : raw.Sequence;
    return { kind: "sequence", calls: calls.filter((c: unknown) => typeof c === "object").map(step) };
  }
  return undefined;
}

function outcome(signature: string, r: any): TestOutcome {
  const name = signature.replace(/\(.*$/s, "");
  const status = r.status === "Success" ? "passed" : r.status === "Skipped" ? "skipped" : "failed";
  const t: TestOutcome = {
    name,
    signature,
    status,
    reason: r.reason ?? undefined,
    durationMs: parseDuration(r.duration),
    counterexample: counterexample(r.counterexample),
    invariantFailures: [],
    logs: Array.isArray(r.decoded_logs) ? r.decoded_logs : [],
    kind: "other",
  };
  const kind = r.kind ?? {};
  if (kind.Unit) {
    t.kind = "unit";
    t.gas = kind.Unit.gas;
    t.gasLabel = "gas";
  } else if (kind.Fuzz) {
    t.kind = "fuzz";
    t.fuzzRuns = kind.Fuzz.runs;
    if (kind.Fuzz.mean_gas) {
      t.gas = kind.Fuzz.mean_gas;
      t.gasLabel = "mean gas";
    }
  } else if (kind.Invariant) {
    t.kind = "invariant";
    t.fuzzRuns = kind.Invariant.runs;
  }
  for (const f of r.invariant_failures ?? []) {
    const ce = counterexample(f.counterexample);
    t.invariantFailures.push({
      name: f.name ?? name,
      reason: f.reason ?? "",
      calls: ce?.kind === "sequence" ? ce.calls : [],
    });
  }
  if (!t.reason && t.invariantFailures.length) t.reason = t.invariantFailures.map((f) => `${f.name}: ${f.reason}`).join("\n");
  if (!t.counterexample && t.invariantFailures[0]?.calls.length) {
    t.counterexample = { kind: "sequence", calls: t.invariantFailures[0].calls };
  }
  return t;
}

/** The results object: forge can print other JSON lines first (invariant failure events), and log lines. */
function resultsObject(stdout: string): Record<string, any> {
  const isResults = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((s) => s && typeof s === "object" && "test_results" in s);
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    // Usually one line; older versions pretty-printed, so try the rest of the output from here too.
    for (const text of [lines[i], lines.slice(i).join("\n")]) {
      try {
        const v = JSON.parse(text);
        if (isResults(v)) return v;
      } catch {
        // not this one
      }
    }
  }
  throw new Error("forge printed no test results");
}

/** Parses forge's JSON test results. Throws when there are none. */
export function parseTestJson(stdout: string): SuiteResult[] {
  const data = resultsObject(stdout);
  const suites: SuiteResult[] = [];
  for (const [id, suite] of Object.entries<any>(data)) {
    const cut = id.lastIndexOf(":");
    suites.push({
      file: id.slice(0, cut),
      contract: id.slice(cut + 1),
      durationMs: parseDuration(suite.duration),
      tests: Object.entries<any>(suite.test_results ?? {}).map(([sig, r]) => outcome(sig, r)),
      warnings: suite.warnings ?? [],
    });
  }
  return suites;
}
