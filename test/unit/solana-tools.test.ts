import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { logFileProgram, parseProgramLogs, summarise } from "../../src/solana/computeUnits";
import { parseIdl, typeName } from "../../src/solana/idl";

// program-log.txt and idl-demo.json are what anchor-cli 0.31.1 wrote for a small counter program.
const data = (f: string) => fs.readFileSync(path.resolve(__dirname, "../../../test/unit/data", f), "utf8");
const demo = "9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1";

suite("Solana compute units", () => {
  test("reads a real program log", () => {
    const samples = parseProgramLogs(data("program-log.txt"));
    assert.deepStrictEqual(
      samples.map((s) => [s.instruction, s.units, s.budget, s.depth, s.failed]),
      [
        ["Initialize", 8569, 200000, 1, false],
        ["Increment", 3403, 200000, 1, false],
        ["Burn", 17138, 200000, 1, false],
      ],
    );
  });

  test("keeps a CPI's name and units apart from its caller", () => {
    const log = [
      "Transaction executed in slot 5:",
      "  Signature: sigA",
      "  Status: Error processing Instruction 0: custom program error: 0x1770",
      "  Log Messages:",
      `    Program ${demo} invoke [1]`,
      "    Program log: Instruction: Outer",
      "    Program Other1111111111111111111111111111111111111 invoke [2]",
      "    Program log: Instruction: Inner",
      "    Program Other1111111111111111111111111111111111111 consumed 1000 of 190000 compute units",
      "    Program Other1111111111111111111111111111111111111 success",
      `    Program ${demo} consumed 5000 of 200000 compute units`,
      `    Program ${demo} failed: custom program error: 0x1770`,
    ].join("\n");
    const samples = parseProgramLogs(log);
    assert.deepStrictEqual(
      samples.map((s) => [s.program.slice(0, 5), s.instruction, s.units, s.depth, s.failed]),
      [
        ["Other", "Inner", 1000, 2, true],
        ["9Svst", "Outer", 5000, 1, true],
      ],
    );
    // Only the workspace's programs, and a transaction seen in two logs counts once.
    const summary = summarise([samples, samples], new Set([demo]));
    assert.deepStrictEqual(
      summary.map((s) => [s.instruction, s.count, s.max, s.failed]),
      [["Outer", 1, 5000, 1]],
    );
  });

  test("summarises min, max and average per instruction", () => {
    const s = (units: number, signature: string) => ({ signature, program: demo, instruction: "Burn", units, budget: 200000, depth: 1, failed: false });
    const [row] = summarise([[s(100, "a"), s(300, "b")]]);
    assert.deepStrictEqual([row.count, row.min, row.max, row.avg], [2, 100, 300, 200]);
  });

  test("program from a log file name", () => {
    assert.deepStrictEqual(logFileProgram(`${demo}.demo.log`), { address: demo, name: "demo" });
    assert.strictEqual(logFileProgram("notes.txt"), undefined);
  });
});

suite("Solana IDL", () => {
  test("Anchor 0.30+ IDL", () => {
    const idl = parseIdl(JSON.parse(data("idl-demo.json")));
    assert.strictEqual(idl.name, "demo");
    assert.strictEqual(idl.address, demo);
    assert.strictEqual(idl.legacy, false);
    assert.deepStrictEqual(
      idl.nodes.map((n) => [n.label, n.description]),
      [
        ["Instructions", "3"],
        ["Accounts", "1"],
        ["Types", "2"],
        ["Events", "1"],
        ["Errors", "2"],
      ],
    );
    const init = idl.nodes[0].children!.find((n) => n.label === "initialize")!;
    assert.strictEqual(init.description, "start: u64");
    const accounts = init.children![0].children!;
    assert.deepStrictEqual(
      accounts.map((a) => [a.label, a.description]),
      [
        ["counter", "mut, PDA"],
        ["user", "mut, signer"],
        ["system_program", "1111…1111"],
      ],
    );
    assert.match(accounts[0].tooltip!, /Seeds: "counter", account: user/);
    const counter = idl.nodes[1].children![0];
    assert.deepStrictEqual(
      counter.children!.map((f) => `${f.label}: ${f.description}`),
      ["count: u64", "authority: pubkey", "bump: u8"],
    );
    assert.deepStrictEqual(
      idl.nodes[4].children!.map((e) => [e.label, e.description]),
      [
        ["6000 ZeroIncrement", "Increment must be positive"],
        ["6001 Overflow", "Counter overflow"],
      ],
    );
  });

  test("legacy IDL (Anchor 0.29 and older)", () => {
    const idl = parseIdl({
      version: "0.1.0",
      name: "legacy",
      instructions: [
        {
          name: "deposit",
          accounts: [
            { name: "vault", isMut: true, isSigner: false },
            { name: "owner", isMut: false, isSigner: true },
            { name: "nested", accounts: [{ name: "inner", isMut: true, isSigner: false }] },
          ],
          args: [
            { name: "amount", type: "u64" },
            { name: "memo", type: { option: "string" } },
          ],
        },
      ],
      accounts: [{ name: "Vault", type: { kind: "struct", fields: [{ name: "owner", type: "publicKey" }] } }],
      types: [{ name: "Side", type: { kind: "enum", variants: [{ name: "Bid" }, { name: "Ask" }] } }],
      events: [{ name: "Deposited", fields: [{ name: "amount", type: "u64", index: false }] }],
      errors: [{ code: 6000, name: "TooSmall", msg: "Too small" }],
      metadata: { address: "Legacy1111111111111111111111111111111111111" },
    });
    assert.strictEqual(idl.legacy, true);
    assert.strictEqual(idl.name, "legacy");
    assert.strictEqual(idl.address, "Legacy1111111111111111111111111111111111111");
    const ix = idl.nodes[0].children![0];
    assert.strictEqual(ix.description, "amount: u64, memo: Option<string>");
    assert.deepStrictEqual(
      ix.children![0].children!.map((a) => [a.label, a.description]),
      [
        ["vault", "mut"],
        ["owner", "signer"],
        ["nested", "group"],
      ],
    );
    assert.strictEqual(idl.nodes[1].children![0].children![0].description, "pubkey");
    assert.deepStrictEqual(
      idl.nodes[3].children![0].children!.map((f) => f.label),
      ["amount"],
    );
  });

  test("type names", () => {
    assert.strictEqual(typeName({ vec: { defined: { name: "Pair", generics: [{ kind: "type", type: "u8" }] } } }), "Vec<Pair<u8>>");
    assert.strictEqual(typeName({ array: ["u8", 32] }), "[u8; 32]");
    assert.strictEqual(typeName({ defined: "Legacy" }), "Legacy");
  });
});
