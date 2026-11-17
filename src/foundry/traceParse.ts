import { stripAnsi } from "../core/exec";

// Reads the call traces `forge test -vvvv` prints. The JSON output has traces too, but undecoded (raw calldata, no
// names); the text is what forge decodes with everything it knows, so that is what is shown.
//
//   [57117] CounterTest::test_FailsOnPurpose()
//     ├─ [44899] Counter::setNumber(5)
//     │   ├─ emit Set(value: 5)
//     │   └─ ← [Stop]
//     └─ ← [Revert] number should be six

export interface TraceNode {
  kind: "call" | "create" | "return" | "emit" | "other";
  text: string;
  gas?: number;
  /** For calls: the contract or label before `::`. */
  target?: string;
  /** For calls: the function name. */
  fn?: string;
  /** For calls and creates: "staticcall", "delegatecall" and the like. */
  callKind?: string;
  /** For returns: Return, Revert, Stop... */
  status?: string;
  /** A call whose own return is a revert. */
  reverted?: boolean;
  children: TraceNode[];
}

export interface TestTrace {
  /** Top-level frames: setUp, then the test (or the last failing run of a fuzz test). */
  roots: TraceNode[];
  logs: string[];
}

function node(text: string): TraceNode {
  const n: TraceNode = { kind: "other", text, children: [] };
  let m = text.match(/^\[(\d+)\]\s+(.*)$/);
  let body = text;
  if (m) {
    n.gas = Number(m[1]);
    body = m[2];
  }
  if ((m = body.match(/^→ new ([^@\s]+)(?:@(0x[0-9a-fA-F]+))?/))) {
    n.kind = "create";
    n.target = m[1];
  } else if ((m = body.match(/^← \[(\w+)\]\s*(.*)$/))) {
    n.kind = "return";
    n.status = m[1];
  } else if (body.startsWith("emit ")) {
    n.kind = "emit";
  } else if ((m = body.match(/^([^\s:]+)::([A-Za-z_$][\w$]*)\(/))) {
    n.kind = "call";
    n.target = m[1];
    n.fn = m[2];
    n.callKind = body.match(/\[(staticcall|delegatecall|callcode)\]\s*$/)?.[1];
  } else if ((m = body.match(/^([^\s:]+)::(fallback|receive)\b/))) {
    n.kind = "call";
    n.target = m[1];
    n.fn = m[2];
  }
  n.text = body;
  return n;
}

export function parseTraces(output: string): TestTrace {
  const lines = stripAnsi(output).split(/\r?\n/);
  const roots: TraceNode[] = [];
  const logs: string[] = [];
  let section: "none" | "logs" | "traces" = "none";
  let stack: TraceNode[] = [];
  for (const line of lines) {
    if (/^Logs:\s*$/.test(line)) {
      section = "logs";
      continue;
    }
    if (/^Traces:\s*$/.test(line)) {
      section = "traces";
      stack = [];
      continue;
    }
    if (line.trim() === "") {
      stack = [];
      continue;
    }
    if (/^\S/.test(line)) {
      section = "none";
      continue;
    }
    if (section === "logs") {
      logs.push(line.trim());
      continue;
    }
    if (section !== "traces") continue;
    const connector = line.search(/[├└]─ /);
    const depth = connector === -1 ? 0 : (connector - 4) / 4 + 1;
    const text = (connector === -1 ? line : line.slice(connector + 3)).trim();
    if (!Number.isInteger(depth) || depth < 0) continue;
    const n = node(text);
    if (depth === 0) {
      roots.push(n);
      stack = [n];
      continue;
    }
    const parent = stack[depth - 1];
    if (!parent) continue;
    parent.children.push(n);
    if (n.kind === "return" && n.status === "Revert") parent.reverted = true;
    stack = stack.slice(0, depth);
    stack[depth] = n;
  }
  return { roots, logs };
}
