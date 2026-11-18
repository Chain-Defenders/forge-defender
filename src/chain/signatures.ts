import type { AbiEntry, AbiParam } from "../core/artifacts";
import { canonicalType } from "../core/abi";

// Matching a declaration in Solidity source to its ABI entry, so a hover can show the compiler's own signature.
// Without an artifact, a signature can still be worked out from source when every parameter is an elementary type.

const elementary = /^(uint\d*|int\d*|address|bool|bytes\d*|string|byte)((\[\d*\])*)$/;

/** The canonical form of an elementary source type ("uint" → "uint256"), or undefined for structs, enums, contracts. */
export function canonicalElementary(t: string): string | undefined {
  const m = t.replace(/\s+/g, "").match(elementary);
  if (!m) return undefined;
  let base = m[1];
  if (base === "uint") base = "uint256";
  else if (base === "int") base = "int256";
  else if (base === "byte") base = "bytes1";
  return base + m[2];
}

/** Signature worked out from source types alone, when all of them are elementary. */
export function signatureFromSource(name: string, types: string[]): string | undefined {
  const canon = types.map(canonicalElementary);
  if (canon.some((c) => c === undefined)) return undefined;
  return `${name}(${canon.join(",")})`;
}

function sameType(source: string, p: AbiParam): boolean {
  const canon = canonicalElementary(source);
  if (canon) return canon === canonicalType(p);
  // A user type: compare its last name and array suffix with the ABI's internalType ("struct Lib.Order[]").
  const src = source.replace(/\s+/g, "");
  const [, srcName = src, srcArr = ""] = src.match(/^(?:.*\.)?([A-Za-z_$][\w$]*)((?:\[\d*\])*)$/) ?? [];
  const internal = (p.internalType ?? "").replace(/^(struct|enum|contract)\s+/, "").replace(/\s+/g, "");
  const [, intName = internal, intArr = ""] = internal.match(/^(?:.*\.)?([A-Za-z_$][\w$]*)((?:\[\d*\])*)$/) ?? [];
  return srcName === intName && srcArr === intArr;
}

/** The ABI entry for a declaration: by name, then parameter count, then parameter types (for overloads). */
export function matchAbiEntry(abi: AbiEntry[], kind: "function" | "error" | "event", name: string, sourceTypes: string[]): AbiEntry | undefined {
  // A count that differs from the source means the artifact is out of date, so no match rather than a wrong one.
  const byCount = abi.filter((e) => e.type === kind && e.name === name && (e.inputs ?? []).length === sourceTypes.length);
  if (byCount.length <= 1) return byCount[0];
  const byType = byCount.filter((e) => (e.inputs ?? []).every((p, i) => sameType(sourceTypes[i], p)));
  return byType.length === 1 ? byType[0] : undefined;
}
