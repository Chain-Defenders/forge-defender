import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode, decodePubkey } from "./base58";

// Program derived addresses, as the runtime computes them, and seeds written the way `solana
// find-program-derived-address` takes them: string:, pubkey:, hex:, u8:, and [u|i][16|32|64|128][le|be].
// u16/u32/u64/u128 without a byte order are little-endian, as Anchor programs write them.

const maxSeeds = 16;
const maxSeedLength = 32;
const marker = utf8ToBytes("ProgramDerivedAddress");

export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    // zip215 accepts the same non-canonical encodings as curve25519-dalek, which the runtime uses.
    ed25519.Point.fromHex(bytes, true);
    return true;
  } catch {
    return false;
  }
}

/** The address for these exact seeds, or undefined when it lands on the curve (such an address has a private key). */
export function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array | undefined {
  if (seeds.length > maxSeeds) throw new Error(`at most ${maxSeeds} seeds are allowed`);
  for (const s of seeds) if (s.length > maxSeedLength) throw new Error(`a seed is ${s.length} bytes; at most ${maxSeedLength} are allowed`);
  const h = sha256.create();
  for (const s of seeds) h.update(s);
  h.update(programId).update(marker);
  const hash = h.digest();
  return isOnCurve(hash) ? undefined : hash;
}

export interface Pda {
  address: string;
  bump: number;
}

/** Tries bumps from 255 down, like `Pubkey::find_program_address`. */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Pda {
  // The bump is itself a seed, so the caller's seeds can be at most 15.
  if (seeds.length > maxSeeds - 1) throw new Error(`at most ${maxSeeds - 1} seeds are allowed`);
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (a) return { address: base58Encode(a), bump };
  }
  throw new Error("no valid bump found");
}

export function findProgramAddressFor(programId: string, seeds: string[]): Pda {
  return findProgramAddress(seeds.map(parseSeed), decodePubkey(programId));
}

export function parseSeed(spec: string): Uint8Array {
  const colon = spec.indexOf(":");
  if (colon < 0) throw new Error(`"${spec}": write a seed as type:value, for example string:vault or u64:1`);
  const kind = spec.slice(0, colon).trim().toLowerCase();
  const value = spec.slice(colon + 1);
  if (kind === "string") return utf8ToBytes(value);
  if (kind === "pubkey") return decodePubkey(value);
  if (kind === "hex") {
    const h = value.trim().replace(/^0x/i, "");
    if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error(`"${value}" is not hex bytes`);
    return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  }
  const m = /^([ui])(8|16|32|64|128)(le|be)?$/.exec(kind);
  if (!m) throw new Error(`unknown seed type "${kind}" (use string, pubkey, hex, u8, u16, u32, u64, u128, i8 to i128, with le or be)`);
  return intBytes(value.trim(), m[1] === "i", Number(m[2]), m[3] !== "be");
}

function intBytes(text: string, signed: boolean, bits: number, littleEndian: boolean): Uint8Array {
  if (!/^-?\d+$/.test(text)) throw new Error(`"${text}" is not a whole number`);
  let n = BigInt(text);
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (n < min || n > max) throw new Error(`${text} does not fit in ${signed ? "i" : "u"}${bits}`);
  if (n < 0n) n += 1n << BigInt(bits);
  const out = new Uint8Array(bits / 8);
  for (let i = 0; i < out.length; i++) {
    out[littleEndian ? i : out.length - 1 - i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Splits `string:"two words" u8:1` into seeds; quotes group a value with spaces and are removed. */
export function splitSeeds(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new Error("a quote is not closed");
  if (has) out.push(cur);
  return out;
}
