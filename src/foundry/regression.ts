import { checksumAddress, decodeSimple, solidityLiteral } from "../core/abi";
import { paramTypes, parseSolidity } from "../core/solidity";
import type { CallStep, Counterexample } from "./results";

// Turns a counterexample forge found into an ordinary test, so the failure stays covered after the fuzzer moves on.

export interface RegressionInput {
  /** The test function that failed. */
  testName: string;
  /** Its parameter list as written ("uint256 x, address to"), for fuzz tests. */
  params: string;
  counterexample: Counterexample;
  /** Function names already in the contract, so the new name is unique. */
  existing: Set<string>;
  /** Whether forge-std's `vm` is available in the contract. */
  hasVm: boolean;
}

const cheatcodes = "0x7109709ECfa91a80626fF3989D68f67F5b1DD12D";

function uniqueName(base: string, existing: Set<string>): string {
  for (let i = 1; ; i++) {
    const name = `${base}_${i}`;
    if (!existing.has(name)) return name;
  }
}

function hex(data: string): string {
  return `hex"${data.replace(/^0x/, "")}"`;
}

// Without forge-std there is no `vm`; the cheatcodes are reachable at their fixed address all the same.
function cheat(hasVm: boolean, call: string, sig: string, arg: string): string {
  return hasVm ? `vm.${call}(${arg});` : `(ok, ) = address(${cheatcodes}).call(abi.encodeWithSignature("${sig}", ${arg}));`;
}

function sequenceLines(calls: CallStep[], hasVm: boolean): string[] {
  const lines = ["bool ok;"];
  for (const c of calls) {
    if (c.warp) lines.push(cheat(hasVm, "warp", "warp(uint256)", String(BigInt(c.warp))));
    if (c.roll) lines.push(cheat(hasVm, "roll", "roll(uint256)", String(BigInt(c.roll))));
    lines.push(cheat(hasVm, "prank", "prank(address)", checksumAddress(c.sender)));
    const what = c.signature ? ` // ${c.contractName ? c.contractName.split(":").pop() + "." : ""}${c.signature}${c.args ? " with " + c.args : ""}` : "";
    lines.push(`(ok, ) = ${checksumAddress(c.addr)}.call(${hex(c.calldata)});${what}`);
  }
  return lines;
}

/** The new test function's source, indented for a contract body. */
export function regressionTest(input: RegressionInput): { name: string; code: string } {
  const { testName, counterexample: ce } = input;
  const name = uniqueName(`test_Regression_${testName}`, input.existing);
  let doc: string;
  let body: string[];
  if (ce.kind === "single") {
    const types = paramTypes(input.params);
    const decoded = decodeSimple(types, ce.calldata.replace(/^0x/, "").slice(8));
    doc = `/// Regression: ${testName} failed with ${ce.args || "these inputs"}.`;
    if (decoded) {
      body = [`${testName}(${decoded.map(solidityLiteral).join(", ")});`];
    } else {
      // Arrays and structs: replay the exact calldata, and pass the original revert on.
      body = [
        `(bool ok, bytes memory ret) = address(this).call(${hex(ce.calldata)});`,
        `if (!ok) {`,
        `    assembly {`,
        `        revert(add(ret, 32), mload(ret))`,
        `    }`,
        `}`,
      ];
    }
  } else {
    doc = `/// Regression: ${testName} broke after this sequence of ${ce.calls.length} call${ce.calls.length === 1 ? "" : "s"}.`;
    // Calls in an invariant run may revert without ending it, so their results are not checked here either.
    body = [...sequenceLines(ce.calls, input.hasVm), `${testName}();`];
  }
  const code = [doc, `function ${name}() public {`, ...body.map((l) => "    " + l), `}`].map((l) => "    " + l).join("\n");
  return { name, code };
}

/**
 * Where to insert into `src`: just before the closing brace of `contract`. Returns the offset and the text to
 * insert there (with surrounding blank lines), or undefined when the contract is not in the file.
 */
export function insertion(src: string, contract: string, code: string): { offset: number; text: string } | undefined {
  const c = parseSolidity(src).contracts.find((x) => x.name === contract);
  if (!c) return undefined;
  // Back up over whitespace before the closing brace, so the new function follows the last line of code.
  let at = c.bodyEnd;
  while (at > c.bodyStart + 1 && /\s/.test(src[at - 1])) at--;
  // An empty body gets the function on its own line; otherwise a blank line separates it from the code above.
  const empty = at === c.bodyStart + 1;
  return { offset: at, text: empty ? `\n${code}\n` : `\n\n${code}` };
}

/** True when forge-std's `vm` is in reach: the file imports forge-std (directly or by a remapping named so). */
export function importsForgeStd(src: string): boolean {
  return /import\s+[^;]*forge-std\//.test(src) || /\bis\s+[^{]*\bTest\b/.test(src);
}
