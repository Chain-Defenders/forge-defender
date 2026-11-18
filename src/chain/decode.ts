import type { AbiParam, Artifact } from "../core/artifacts";
import { canonicalType, decodeSimple, selector, signatureOf } from "../core/abi";

// Decoding calldata and revert data by their 4-byte selector, against the project's own contracts plus Solidity's
// built-in Error(string) and Panic(uint256). Nothing here goes online.

export interface Known {
  selector: string;
  signature: string;
  kind: "function" | "error";
  inputs: AbiParam[];
  /** Where it was found: contract names, or "Solidity" for the built-ins. */
  from: string[];
}

export const builtIns: Known[] = [
  { selector: "0x08c379a0", signature: "Error(string)", kind: "error", inputs: [{ name: "message", type: "string" }], from: ["Solidity"] },
  { selector: "0x4e487b71", signature: "Panic(uint256)", kind: "error", inputs: [{ name: "code", type: "uint256" }], from: ["Solidity"] },
];

const panics: Record<number, string> = {
  0x00: "generic compiler panic",
  0x01: "assert() failed",
  0x11: "arithmetic overflow or underflow",
  0x12: "division or modulo by zero",
  0x21: "conversion to an enum out of range",
  0x22: "storage byte array incorrectly encoded",
  0x31: "pop() on an empty array",
  0x32: "array index out of bounds",
  0x41: "too much memory allocated, or an array too large",
  0x51: "call to a zero-initialised internal function",
};

export function panicMeaning(code: bigint): string {
  return panics[Number(code)] ?? "unknown panic code";
}

/** Selectors of every function and custom error in the artifacts, with the built-ins. */
export function buildIndex(artifacts: Artifact[]): Map<string, Known[]> {
  const index = new Map<string, Known[]>();
  const add = (k: Known) => {
    const list = index.get(k.selector) ?? [];
    const same = list.find((x) => x.signature === k.signature && x.kind === k.kind);
    if (same) {
      for (const f of k.from) if (!same.from.includes(f)) same.from.push(f);
    } else {
      list.push({ ...k, from: [...k.from] });
    }
    index.set(k.selector, list);
  };
  for (const b of builtIns) add(b);
  for (const a of artifacts) {
    for (const e of a.abi) {
      if (e.type !== "function" && e.type !== "error") continue;
      const signature = signatureOf(e);
      add({ selector: selector(signature), signature, kind: e.type, inputs: e.inputs ?? [], from: [a.name] });
    }
  }
  return index;
}

/** Hex without spaces or 0x, lower case; undefined when it is not whole bytes of hex. */
export function normaliseHex(input: string): string | undefined {
  const h = input.trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0 || h.length < 8) return undefined;
  return h;
}

export interface DecodedArg {
  name: string;
  type: string;
  value: string;
}

export interface Match {
  known: Known;
  /** Undefined when the arguments use types decodeSimple cannot read (arrays, tuples) or do not fit. */
  args?: DecodedArg[];
  note?: string;
}

export function decodeWith(known: Known, hex: string): Match {
  const types = known.inputs.map(canonicalType);
  const decoded = decodeSimple(types, hex.slice(8));
  if (!decoded) return { known };
  const args = decoded.map((d, i) => ({ name: known.inputs[i]?.name || `arg${i}`, type: d.type, value: d.value }));
  const m: Match = { known, args };
  if (known.signature === "Panic(uint256)" && args[0]) m.note = `Panic 0x${BigInt(args[0].value).toString(16).padStart(2, "0")}: ${panicMeaning(BigInt(args[0].value))}`;
  return m;
}

/** Arguments from `cast decode-calldata` or `cast decode-error --sig`, which print one value per line. */
export function argsFromCast(known: Known, stdout: string): DecodedArg[] | undefined {
  const values = stdout.trim() ? stdout.trim().split(/\r?\n/) : [];
  if (values.length !== known.inputs.length) return undefined;
  return values.map((v, i) => ({ name: known.inputs[i].name || `arg${i}`, type: canonicalType(known.inputs[i]), value: v.trim() }));
}

export function renderDecoded(hex: string, matches: Match[], extra: string[] = []): string {
  const sel = "0x" + hex.slice(0, 8);
  const lines = [`# Decoded data`, "", `Selector: \`${sel}\`  `, `Length: ${hex.length / 2} bytes`, ""];
  if (!matches.length) lines.push("This selector is not in the project's contracts, and it is not Error(string) or Panic(uint256).", "");
  if (matches.length > 1) lines.push(`${matches.length} signatures share this selector. Each reading is shown.`, "");
  for (const m of matches) {
    lines.push(`## ${m.known.kind === "error" ? "Error" : "Function"} \`${m.known.signature}\``, "", `From: ${m.known.from.join(", ")}`, "");
    if (m.note) lines.push(`**${m.note}**`, "");
    if (m.args) {
      if (!m.args.length) lines.push("No arguments.", "");
      else {
        lines.push("| Name | Type | Value |", "|---|---|---|");
        for (const a of m.args) lines.push(`| ${a.name} | ${a.type} | \`${a.value.replace(/[|`\n]/g, " ")}\` |`);
        lines.push("");
      }
    } else {
      lines.push("The arguments could not be decoded with this signature.", "");
    }
  }
  lines.push(...extra);
  lines.push("## Raw data", "", "```", wrap("0x" + hex), "```", "");
  return lines.join("\n");
}

function wrap(h: string): string {
  // The selector on its own line, then one 32-byte word per line, as the ABI lays them out.
  const body = h.slice(10);
  const words = body.match(/.{1,64}/g) ?? [];
  return [h.slice(0, 10), ...words].join("\n");
}
