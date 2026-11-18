import * as assert from "node:assert";
import { allowedFromConfig, blockedHosts, hostAllowed, mergeKeys, parseDoctorJson, parseDoctorText, parseLog, parseScan } from "../../src/keymoat/report";

// Outputs below are from keymoat 0.1.0: the installed build (text doctor) and a fresh build (doctor --json).

const doctorJson = `{
  "version": "0.1.0",
  "sandbox": { "ok": true, "detail": "works: a sandboxed command could not read a protected file" },
  "tools": [
    { "name": "anchor", "through": false, "found": "/Users/dev/.cargo/bin/anchor", "real": "/Users/dev/.cargo/bin/anchor" },
    { "name": "forge", "through": true, "found": "/Users/dev/.keymoat/bin/forge", "real": "/Users/dev/.foundry/bin/forge" },
    { "name": "yarn", "through": false, "found": "", "real": "" }
  ],
  "pathFirst": false,
  "shimDir": "/Users/dev/.keymoat/bin",
  "project": "/Users/dev/p",
  "plainKeys": [
    { "file": "/Users/dev/.config/solana/id.json", "kind": "Solana keypair", "fix": "keymoat keys move /Users/dev/.config/solana/id.json" },
    { "file": "/Users/dev/p/.env", "line": 3, "name": "PRIVATE_KEY", "kind": "EVM private key", "fix": "keymoat keys move /Users/dev/p/.env" }
  ]
}`;

const doctorText = `Sandbox
  ✓ works: a sandboxed command could not read a protected file
Tools
  ✗ anchor     runs directly from /Users/dev/.cargo/bin/anchor, not through keymoat
  ✓ forge      goes through keymoat  (the tool itself: /Users/dev/.foundry/bin/forge)
  ✗ yarn: not found on the PATH

  /Users/dev/.keymoat/bin is not first on the PATH in this terminal. Put this at the end of your shell's start-up file and open a new terminal:

    export PATH="/Users/dev/.keymoat/bin:$PATH"  # keymoat: its tool links go first on the PATH

  With nvm, \`nvm use\` puts Node's folder first again: open a new terminal afterwards.
Keys in plain text
  ✗ /Users/dev/.config/solana/id.json is a Solana keypair in plain text: \`keymoat keys move /Users/dev/.config/solana/id.json\`
  ✗ .env line 3: PRIVATE_KEY (EVM private key): \`keymoat keys move /Users/dev/p/.env\`
`;

suite("keymoat: reading its output", () => {
  test("doctor --json", () => {
    const d = parseDoctorJson(doctorJson);
    assert.strictEqual(d.legacy, false);
    assert.strictEqual(d.sandbox.ok, true);
    assert.deepStrictEqual(d.tools.map((t) => [t.name, t.through]), [["anchor", false], ["forge", true], ["yarn", false]]);
    assert.strictEqual(d.shimDir, "/Users/dev/.keymoat/bin");
    assert.deepStrictEqual(d.plainKeys[1], { file: "/Users/dev/p/.env", line: 3, name: "PRIVATE_KEY", kind: "EVM private key", fix: "keymoat keys move /Users/dev/p/.env" });
    assert.strictEqual(d.plainKeys[0].line, undefined);
  });

  test("plain doctor text from a keymoat without --json reads the same", () => {
    const t = parseDoctorText(doctorText, "/Users/dev/p");
    const j = parseDoctorJson(doctorJson);
    assert.strictEqual(t.legacy, true);
    assert.deepStrictEqual(t.sandbox, j.sandbox);
    assert.deepStrictEqual(t.tools.map((x) => [x.name, x.through]), j.tools.map((x) => [x.name, x.through]));
    assert.strictEqual(t.tools[0].found, "/Users/dev/.cargo/bin/anchor");
    assert.strictEqual(t.shimDir, "/Users/dev/.keymoat/bin");
    assert.strictEqual(t.pathFirst, false);
    assert.deepStrictEqual(t.plainKeys, j.plainKeys);
  });

  test("scan: exit codes 0 and 1 are results, others are failures", () => {
    assert.deepStrictEqual(parseScan("[]\n", 0), []);
    const found = parseScan(`[{"file":"/p/.env","line":2,"name":"PK","kind":"EVM private key","fix":"keymoat keys move /p/.env"}]`, 1);
    assert.strictEqual(found[0].line, 2);
    assert.throws(() => parseScan("", 2), /exit code 2/);
    assert.throws(() => parseScan("", null));
  });

  test("merges findings without duplicates", () => {
    const a = { file: "/a", kind: "k", fix: "" };
    assert.strictEqual(mergeKeys([a], [{ ...a }, { ...a, line: 2 }]).length, 2);
  });
});

suite("keymoat: blocked hosts", () => {
  const log = [
    `{"time":"2026-11-15T12:21:10Z","kind":"bypass","tool":"forge","args":["--version"]}`,
    `{"time":"2026-11-15T12:24:08Z","kind":"blocked-host","tool":"npm","project":"/repo","detail":"fonts.googleapis.com"}`,
    `{"time":"2026-11-15T12:24:18Z","kind":"blocked-host","tool":"npx","project":"/repo","detail":"fonts.googleapis.com"}`,
    `{"time":"2026-11-15T12:25:23Z","kind":"blocked-host","tool":"forge","project":"/repo","detail":"eth.llamarpc.com"}`,
    `{"time":"2026-11-15T12:26:00Z","kind":"blocked-host","tool":"npm","project":"/other","detail":"evil.example"}`,
    `{"time":"2026-11-15T12:27:00Z","kind":"blocked-host","tool":"npm","project":"/repo/contracts","detail":"x.example"}`,
    `{"broken`,
  ].join("\n");

  test("for this project, grouped by host, newest first", () => {
    const events = parseLog(log);
    assert.strictEqual(events.length, 6);
    // keymoat's project is the git root (/repo); the Foundry project is below it.
    const b = blockedHosts(events, ["/repo/contracts"]);
    assert.deepStrictEqual(
      b.map((x) => [x.host, x.project, x.count]),
      [
        ["x.example", "/repo/contracts", 1],
        ["eth.llamarpc.com", "/repo", 1],
        ["fonts.googleapis.com", "/repo", 2],
      ],
    );
    assert.strictEqual(b[2].last, "2026-11-15T12:24:18Z");
    assert.deepStrictEqual(blockedHosts(events, ["/elsewhere"]), []);
  });

  test("hides hosts keymoat's settings now allow", () => {
    const allowed = allowedFromConfig(JSON.stringify({ allowHosts: ["*.googleapis.com"], projects: { "/repo": { hosts: ["eth.llamarpc.com"] } } }));
    assert.deepStrictEqual(
      blockedHosts(parseLog(log), ["/repo"], allowed).map((x) => x.host),
      ["x.example"],
    );
    assert.strictEqual(allowedFromConfig("not json")("a", "/repo"), false);
    assert.strictEqual(hostAllowed("googleapis.com", ["*.googleapis.com"]), true);
    assert.strictEqual(hostAllowed("evilgoogleapis.com", ["*.googleapis.com"]), false);
  });
});
