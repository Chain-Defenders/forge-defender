import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import data from "../../src/security/data/advisories.json";
import { anchorDeps, foundryDeps, matchAdvisories, parseCargoLock, parseSoldeerDeps, type AdvisoryData } from "../../src/security/dependencies";

const advisories = data as AdvisoryData;

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-deps-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

suite("security: dependencies", () => {
  const roots: string[] = [];
  teardown(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  test("the advisory data comes from the GitHub Advisory Database and says when", () => {
    assert.match(advisories.source, /GitHub Advisory Database/);
    assert.match(advisories.generated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(advisories.advisories.length > 0);
    assert.ok(advisories.advisories.every((a) => /^GHSA-/.test(a.id) && a.url.startsWith("https://github.com/advisories/")));
  });

  test("git submodules: OpenZeppelin's contracts/package.json, else git describe", async () => {
    const root = tree({
      ".gitmodules": [
        '[submodule "lib/forge-std"]',
        "\tpath = lib/forge-std",
        "\turl = https://github.com/foundry-rs/forge-std",
        '[submodule "lib/openzeppelin-contracts"]',
        "\tpath = lib/openzeppelin-contracts",
        "\turl = https://github.com/OpenZeppelin/openzeppelin-contracts",
        '[submodule "lib/solmate"]',
        "\tpath = lib/solmate",
        "\turl = https://github.com/transmissions11/solmate",
      ].join("\n"),
      "lib/openzeppelin-contracts/package.json": '{"name":"openzeppelin-solidity","version":"4.8.0"}',
      "lib/openzeppelin-contracts/contracts/package.json": '{"name":"@openzeppelin/contracts","version":"4.8.0"}',
      "lib/solmate/README.md": "",
      "lib/forge-std/package.json": '{"name":"forge-std","version":"1.9.0"}',
    });
    roots.push(root);
    const deps = await foundryDeps(root, ["lib"], async (dir) => (dir.endsWith("solmate") ? "v7-12-gabc1234" : undefined));
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.version, path.basename(d.file), d.line, d.via]),
      [
        ["@openzeppelin/contracts", "4.8.0", ".gitmodules", 3, "git submodule"],
        ["solmate", "v7-12-gabc1234", ".gitmodules", 6, "git submodule"],
      ],
    );
    const hits = matchAdvisories(deps, advisories);
    assert.ok(hits.some((h) => h.advisory.id === "GHSA-93hq-5wgc-jc82" && h.fixed === "4.8.3"));
    assert.ok(hits.every((h) => h.dep.name === "@openzeppelin/contracts"));
  });

  test("Soldeer: installed folder wins over the declared version", async () => {
    const root = tree({
      "foundry.toml": '[profile.default]\nsrc = "src"\n\n[dependencies]\nforge-std = "1.9.4"\n"@openzeppelin-contracts" = { version = "5.0.0" }\n"@openzeppelin-contracts-upgradeable" = "5.3.0"\n',
      "dependencies/@openzeppelin-contracts-5.0.1/package.json": "{}",
      "dependencies/@openzeppelin-contracts-upgradeable-5.3.0/package.json": "{}",
    });
    roots.push(root);
    assert.deepStrictEqual(parseSoldeerDeps(fs.readFileSync(path.join(root, "foundry.toml"), "utf8")).map((d) => [d.name, d.version, d.line]), [
      ["forge-std", "1.9.4", 4],
      ["@openzeppelin-contracts", "5.0.0", 5],
      ["@openzeppelin-contracts-upgradeable", "5.3.0", 6],
    ]);
    const deps = await foundryDeps(root, ["lib"], async () => undefined);
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.version, d.line]),
      [
        ["@openzeppelin/contracts", "5.0.1", 5],
        ["@openzeppelin/contracts-upgradeable", "5.3.0", 6],
      ],
    );
    const ids = matchAdvisories(deps, advisories).map((h) => `${h.dep.name}:${h.advisory.id}`);
    assert.ok(ids.includes("@openzeppelin/contracts:GHSA-9vx6-7xxf-x967"));
    assert.ok(ids.includes("@openzeppelin/contracts-upgradeable:GHSA-9rcw-c2f9-2j55"));
  });

  test("npm: node_modules version, or an exact declared one", async () => {
    const root = tree({
      "package.json": '{\n  "dependencies": {\n    "@openzeppelin/contracts": "^4.9.0",\n    "solady": "0.0.200"\n  }\n}\n',
      "node_modules/@openzeppelin/contracts/package.json": '{"name":"@openzeppelin/contracts","version":"4.9.4"}',
    });
    roots.push(root);
    const deps = await foundryDeps(root, ["lib"], async () => undefined);
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.version, d.line]),
      [
        ["@openzeppelin/contracts", "4.9.4", 2],
        ["solady", "0.0.200", 3],
      ],
    );
    assert.ok(matchAdvisories(deps, advisories).some((h) => h.advisory.id === "GHSA-699g-q6qh-q4v8"));
  });

  test("Anchor: Cargo.lock versions on the Cargo.toml line that declares them", () => {
    const root = tree({
      "Cargo.toml": '[workspace]\nmembers = ["programs/*"]\n',
      "programs/vault/Cargo.toml": '[package]\nname = "vault"\n\n[dependencies]\nanchor-lang = { version = "1.0.1", features = ["init-if-needed"] }\n',
      "Cargo.lock": '# generated\nversion = 3\n\n[[package]]\nname = "anchor-lang"\nversion = "1.0.1"\n\n[[package]]\nname = "solana-program"\nversion = "2.1.0"\n',
    });
    roots.push(root);
    assert.strictEqual(parseCargoLock(fs.readFileSync(path.join(root, "Cargo.lock"), "utf8")).length, 2);
    const deps = anchorDeps(root);
    assert.deepStrictEqual(
      deps.map((d) => [d.name, d.version, path.relative(root, d.file), d.line]),
      [
        ["anchor-lang", "1.0.1", path.join("programs", "vault", "Cargo.toml"), 4],
        ["solana-program", "2.1.0", "Cargo.lock", 8],
      ],
    );
    const hits = matchAdvisories(deps, advisories);
    assert.deepStrictEqual(
      hits.map((h) => [h.advisory.id, h.fixed]),
      [["GHSA-c6rc-8jpp-2fgc", "1.0.2"]],
    );
  });
});
