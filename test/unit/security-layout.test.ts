import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { baselinePath, compareLayouts, layoutRows, looksUpgradeable, parseLayout, stripLayout, structRows, typeLabel } from "../../src/security/layout";

// The layouts are real `forge inspect <path>:<Name> storageLayout --json` output (forge 1.9.0) of a VaultV1 and
// variations of it as VaultV2; see test/unit/data/layouts.
const dir = path.resolve(__dirname, "../../../test/unit/data/layouts");
const load = (name: string) => parseLayout(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
const v1 = stripLayout(load("v1"));
const against = (name: string) => compareLayouts(v1, load(name));
const kinds = (name: string) => against(name).map((i) => `${i.kind}:${i.label}`).sort();

suite("security: storage layout", () => {
  test("strips AST ids from the baseline", () => {
    const text = JSON.stringify(v1);
    assert.ok(!text.includes("astId"));
    assert.ok(!text.includes('"contract"'));
    assert.strictEqual(v1.storage.length, 6);
  });

  test("the same layout in a renamed contract is fine", () => {
    assert.deepStrictEqual(against("unchanged"), []);
  });

  test("new variables that shrink __gap by the slots they take are fine", () => {
    assert.deepStrictEqual(against("gap-ok"), []);
  });

  test("new variables without shrinking __gap break the gap", () => {
    const issues = against("gap-wrong");
    assert.deepStrictEqual(issues.map((i) => i.kind), ["gap"]);
    assert.match(issues[0].message, /__gap moved from slot 4 to slot 6/);
  });

  test("a gap shrunk by fewer slots than the new variables take", () => {
    const issues = against("gap-short");
    assert.deepStrictEqual(issues.map((i) => i.kind), ["gap"]);
    assert.match(issues[0].message, /__gap shrank by 1 slot, but the variables before it take 2\. It must end at slot 52, not 53/);
  });

  test("a variable inserted before existing ones", () => {
    assert.deepStrictEqual(kinds("insert"), ["gap:__gap", "inserted:fee", "moved:all", "moved:positions", "moved:total"]);
  });

  test("a removed variable", () => {
    assert.deepStrictEqual(kinds("remove"), ["gap:__gap", "moved:all", "moved:positions", "removed:total"]);
  });

  test("a type that changed size", () => {
    // uint128 packs into slot 0 after the two Initializable fields, so it also moves, and everything after it.
    const issues = against("type");
    assert.match(issues[0].message, /total: type changed from uint256 to uint128 \(32 to 16 bytes\)/);
    assert.deepStrictEqual(kinds("type"), ["gap:__gap", "moved:all", "moved:positions", "moved:total", "type:total"]);
  });

  test("a rename at the same slot is only a warning", () => {
    const issues = against("rename");
    assert.deepStrictEqual(issues.map((i) => [i.kind, i.severity]), [["renamed", "warning"]]);
    assert.match(issues[0].message, /total renamed to totalAssets/);
  });

  test("a struct member added at the end: fine in a mapping, not in an array", () => {
    const issues = against("struct-append");
    assert.deepStrictEqual(issues.map((i) => `${i.kind}:${i.label}`), ["type:all"]);
    assert.match(issues[0].message, /struct Position grew from 64 to 96 bytes/);
  });

  test("reordered struct members", () => {
    const issues = against("struct-reorder");
    assert.ok(issues.length >= 2);
    assert.ok(issues.every((i) => i.kind === "type" && i.severity === "error"));
    assert.ok(issues.some((i) => /positions: struct Position: member amount moved from slot 0 offset 0 to slot 0 offset 8/.test(i.message)));
  });

  test("table rows and readable types", () => {
    const l = load("v1");
    const rows = layoutRows(l);
    assert.deepStrictEqual(rows[1], { label: "_initializing", type: "bool", slot: "0", offset: 1, bytes: 1 });
    assert.strictEqual(rows[3].type, "mapping(address => struct Position)");
    assert.strictEqual(typeLabel(l, l.storage[5].type), "uint256[48]");
    assert.deepStrictEqual(structRows(l)[0].members.map((m) => m.label), ["amount", "since", "who"]);
  });

  test("recognises upgradeable contracts", () => {
    assert.ok(looksUpgradeable(["Initializable", "OwnableUpgradeable"], [], ""));
    assert.ok(looksUpgradeable(["UUPSUpgradeable"], [], ""));
    assert.ok(looksUpgradeable([], ["initialize"], ""));
    assert.ok(looksUpgradeable([], [], "constructor() { _disableInitializers(); }"));
    assert.ok(!looksUpgradeable(["ERC20"], ["transfer"], "uint256 x;"));
  });

  test("baseline path mirrors the source path", () => {
    assert.strictEqual(baselinePath("src/proxy/Vault.sol", "Vault"), ".forgedefender/storage/src/proxy/Vault.sol/Vault.json");
  });
});
