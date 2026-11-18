// Contract size limits: runtime code by EIP-170, initcode by EIP-3860. A contract over either cannot be deployed to
// Ethereum mainnet or most other chains.

export const RUNTIME_LIMIT = 24_576;
export const INITCODE_LIMIT = 49_152;
export const WARN_AT = 0.9;

export interface ContractSize {
  runtime: number;
  init: number;
}

/** `forge build --sizes --json`: { "Name": { runtime_size, init_size, ... } }. Keys may be "path:Name" when names clash. */
export function parseSizes(stdout: string): Map<string, ContractSize> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("no JSON in forge's output");
  const d = JSON.parse(stdout.slice(start, end + 1)) as Record<string, { runtime_size?: number; init_size?: number }>;
  const out = new Map<string, ContractSize>();
  for (const [name, s] of Object.entries(d)) {
    if (typeof s?.runtime_size !== "number" || typeof s?.init_size !== "number") continue;
    out.set(name, { runtime: s.runtime_size, init: s.init_size });
  }
  return out;
}

export interface SizeFinding {
  severity: "warning" | "error";
  message: string;
}

const n = (x: number) => x.toLocaleString("en-GB");

/** What to say about a contract's size, or undefined when it is comfortably under both limits. */
export function judgeSize(name: string, s: ContractSize): SizeFinding | undefined {
  const parts: SizeFinding[] = [];
  const check = (size: number, limit: number, what: string, eip: string) => {
    if (size > limit) {
      parts.push({
        severity: "error",
        message: `${what} is ${n(size)} bytes, ${n(size - limit)} over the ${n(limit)}-byte limit (${eip}). It cannot be deployed to mainnet.`,
      });
    } else if (size >= limit * WARN_AT) {
      parts.push({
        severity: "warning",
        message: `${what} is ${n(size)} bytes, ${Math.floor((size / limit) * 100)}% of the ${n(limit)}-byte limit (${eip}).`,
      });
    }
  };
  check(s.runtime, RUNTIME_LIMIT, "Runtime code", "EIP-170");
  check(s.init, INITCODE_LIMIT, "Initcode", "EIP-3860");
  if (!parts.length) return undefined;
  return {
    severity: parts.some((p) => p.severity === "error") ? "error" : "warning",
    message: `${name}: ${parts.map((p) => p.message).join(" ")}`,
  };
}
