import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { AbiEntry, AbiParam } from "./artifacts";

// Signatures, selectors and checksummed addresses, and decoding of the ABI's simple types.

export function keccakHex(text: string): string {
  return bytesToHex(keccak_256(utf8ToBytes(text)));
}

/** Canonical type of a parameter: tuples are spelled out, as in a signature. */
export function canonicalType(p: AbiParam): string {
  if (p.type.startsWith("tuple")) {
    return `(${(p.components ?? []).map(canonicalType).join(",")})${p.type.slice("tuple".length)}`;
  }
  return p.type;
}

export function signatureOf(e: AbiEntry): string {
  return `${e.name ?? ""}(${(e.inputs ?? []).map(canonicalType).join(",")})`;
}

/** 4-byte selector for functions and errors, as 0x-hex. */
export function selector(signature: string): string {
  return "0x" + keccakHex(signature).slice(0, 8);
}

/** 32-byte topic for events, as 0x-hex. */
export function eventTopic(signature: string): string {
  return "0x" + keccakHex(signature);
}

/** EIP-55 checksummed address. */
export function checksumAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, "");
  const h = keccakHex(a);
  let out = "0x";
  for (let i = 0; i < a.length; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

export type Decoded = { type: string; value: string };

const isStaticElementary = (t: string) => /^(u?int\d*|address|bool|bytes([1-9]|[12]\d|3[0-2]))$/.test(t);

/**
 * Decodes calldata arguments (without the selector) for simple types: integers, address, bool, bytesN, bytes and
 * string. Returns undefined for anything else (arrays, tuples), so the caller can fall back to raw calldata.
 */
export function decodeSimple(types: string[], dataHex: string): Decoded[] | undefined {
  const data = dataHex.replace(/^0x/, "");
  const word = (i: number) => data.slice(i * 64, i * 64 + 64);
  const out: Decoded[] = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const w = word(i);
    if (w.length !== 64) return undefined;
    if (isStaticElementary(t)) {
      if (t === "address") out.push({ type: t, value: checksumAddress(w.slice(24)) });
      else if (t === "bool") out.push({ type: t, value: BigInt("0x" + w) === 0n ? "false" : "true" });
      else if (t.startsWith("bytes")) out.push({ type: t, value: "0x" + w.slice(0, Number(t.slice(5)) * 2) });
      else if (t.startsWith("uint")) out.push({ type: t, value: BigInt("0x" + w).toString() });
      else {
        const bits = Number(t.slice(3) || 256);
        let v = BigInt("0x" + w) & ((1n << BigInt(bits)) - 1n);
        if (v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits);
        out.push({ type: t, value: v.toString() });
      }
    } else if (t === "bytes" || t === "string") {
      const off = Number(BigInt("0x" + w)) * 2;
      const len = Number(BigInt("0x" + (data.slice(off, off + 64) || "0")));
      const body = data.slice(off + 64, off + 64 + len * 2);
      if (body.length !== len * 2) return undefined;
      out.push({ type: t, value: t === "bytes" ? "0x" + body : Buffer.from(body, "hex").toString("utf8") });
    } else {
      return undefined;
    }
  }
  return out;
}

/** A Solidity literal for a decoded value, for generated test code. */
export function solidityLiteral(d: Decoded): string {
  switch (true) {
    case d.type === "address":
      return d.value;
    case d.type === "string":
      // Plain printable ASCII as a literal; anything else as its bytes, which needs no escaping rules.
      return /^[\x20-\x7e]*$/.test(d.value) && !/["\\]/.test(d.value)
        ? `"${d.value}"`
        : `string(hex"${Buffer.from(d.value, "utf8").toString("hex")}")`;
    case d.type === "bytes":
      return `hex"${d.value.slice(2)}"`;
    case /^bytes\d+$/.test(d.type):
      return `${d.type}(${d.value})`;
    case d.type.startsWith("int") && d.value.startsWith("-"):
      // type(int256).min cannot be written as a negative literal; any other value can.
      return `${d.type}(${d.value})`;
    default:
      return d.value;
  }
}
