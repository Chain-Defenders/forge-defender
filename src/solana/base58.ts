// Base58 with the Bitcoin alphabet, which Solana uses for addresses and signatures.

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const index = new Map([...alphabet].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => alphabet[d]).join("");
}

/** Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const v = index.get(text[i]);
    if (v === undefined) throw new Error(`"${text[i]}" is not a base58 character`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  bytes.reverse().forEach((b, i) => (out[zeros + i] = b));
  return out;
}

/** A 32-byte public key from base58; throws with a short reason otherwise. */
export function decodePubkey(text: string): Uint8Array {
  const bytes = base58Decode(text.trim());
  if (bytes.length !== 32) throw new Error(`"${text}" is not a public key (${bytes.length} bytes, expected 32)`);
  return bytes;
}
