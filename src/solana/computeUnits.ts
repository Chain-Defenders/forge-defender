// Reads the transaction logs `anchor test` streams into .anchor/program-logs/<address>.<name>.log and sums up the
// compute units each instruction used. Anchor programs log "Instruction: Name" first thing, so the name is the
// first such line inside the program's own invoke; CPIs are tracked on a stack so their lines are not mixed in.

export interface CuSample {
  signature?: string;
  program: string;
  instruction: string;
  units: number;
  budget: number;
  /** 1 for the top-level instruction, more for a CPI. */
  depth: number;
  failed: boolean;
}

export interface CuSummary {
  program: string;
  instruction: string;
  count: number;
  min: number;
  max: number;
  avg: number;
  /** Largest budget seen, usually 200000 unless the transaction asked for more. */
  budget: number;
  failed: number;
}

const unknown = "(no instruction name)";

export function parseProgramLogs(text: string): CuSample[] {
  const out: CuSample[] = [];
  let signature: string | undefined;
  let failedTx = false;
  let stack: { program: string; instruction?: string; depth: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (line.startsWith("Transaction executed in slot")) {
      signature = undefined;
      failedTx = false;
      stack = [];
    } else if ((m = /^Signature: (\w+)/.exec(line))) {
      signature = m[1];
    } else if ((m = /^Status: (.*)$/.exec(line))) {
      failedTx = m[1] !== "Ok";
    } else if ((m = /^Program (\w+) invoke \[(\d+)\]$/.exec(line))) {
      stack.push({ program: m[1], depth: Number(m[2]) });
    } else if ((m = /^Program log: Instruction: (.+)$/.exec(line))) {
      const top = stack[stack.length - 1];
      if (top && !top.instruction) top.instruction = m[1].trim();
    } else if ((m = /^Program (\w+) consumed (\d+) of (\d+) compute units$/.exec(line))) {
      const top = stack[stack.length - 1];
      if (top && top.program === m[1]) {
        out.push({
          signature,
          program: m[1],
          instruction: top.instruction ?? unknown,
          units: Number(m[2]),
          budget: Number(m[3]),
          depth: top.depth,
          failed: failedTx,
        });
      }
    } else if ((m = /^Program (\w+) (success|failed)/.exec(line))) {
      const i = stack.map((f) => f.program).lastIndexOf(m[1]);
      if (i >= 0) stack.length = i;
    }
  }
  return out;
}

/**
 * Groups samples (one list per log file) by program and instruction, keeping only the given programs (the
 * workspace's own) and counting each transaction once even when it shows up in the logs of two programs.
 */
export function summarise(logs: CuSample[][], programs?: Set<string>): CuSummary[] {
  const earlier = new Set<string>();
  const groups = new Map<string, CuSample[]>();
  for (const samples of logs) {
    const here = new Set<string>();
    for (const s of samples) {
      if (s.signature) {
        if (earlier.has(s.signature)) continue;
        here.add(s.signature);
      }
      if (programs && !programs.has(s.program)) continue;
      const k = `${s.program}\0${s.instruction}`;
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    for (const sig of here) earlier.add(sig);
  }
  return [...groups.values()]
    .map((g) => {
      const units = g.map((s) => s.units);
      return {
        program: g[0].program,
        instruction: g[0].instruction,
        count: g.length,
        min: Math.min(...units),
        max: Math.max(...units),
        avg: Math.round(units.reduce((a, b) => a + b, 0) / g.length),
        budget: Math.max(...g.map((s) => s.budget)),
        failed: g.filter((s) => s.failed).length,
      };
    })
    .sort((a, b) => b.max - a.max);
}

/** "<address>.<name>.log" → address and name. */
export function logFileProgram(fileName: string): { address: string; name?: string } | undefined {
  const m = /^(\w{32,44})(?:\.(.+))?\.log$/.exec(fileName);
  return m ? { address: m[1], name: m[2] } : undefined;
}
