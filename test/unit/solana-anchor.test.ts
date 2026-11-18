import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverMocha, type MochaNode } from "../../src/anchor/mocha";
import { anchorConfigFrom } from "../../src/anchor/config";
import { parseToml } from "../../src/anchor/toml";
import { globToRegExp, grepFor, isMochaScript, parseMarker, parseSpec, runProblem, scriptArgs, stackLocation, testScriptGlobs } from "../../src/anchor/run";
import { markerPrefix } from "../../src/anchor/reporter";

const data = (f: string) => fs.readFileSync(path.resolve(__dirname, "../../../test/unit/data", f), "utf8");
const shape = (nodes: MochaNode[]): unknown[] =>
  nodes.map((n) => [n.kind, n.title, n.line, ...(n.modifier ? [n.modifier] : []), ...(n.children.length ? [shape(n.children)] : [])]);

suite("Anchor test discovery", () => {
  test("nested describe/it with lines, skip and only", () => {
    const src = [
      'import * as anchor from "@coral-xyz/anchor";', // 0
      'describe("demo", () => {', // 1
      '  it("initializes", async () => {', // 2
      "    const re = /it\\(\"not a test\"/;", // 3
      "  });", // 4
      "  // it(\"commented out\", () => {});", // 5
      "  describe('increment', function () {", // 6
      "    it.only(`adds`, async () => {});", // 7
      '    it.skip("is skipped", async () => {});', // 8
      '    xit("also skipped", () => {});', // 9
      '    it("pending");', // 10
      "    it(`dynamic ${name}`, () => {});", // 11
      "    /* describe(\"in a comment\") */", // 12
      '    foo.it("not mocha", () => {});', // 13
      "  });", // 14
      '  context.skip("later", () => { test("inner", () => {}); });', // 15
      "});", // 16
      'it("top level", () => { const s = "})"; });', // 17
    ].join("\n");
    assert.deepStrictEqual(shape(discoverMocha(src)), [
      [
        "suite",
        "demo",
        1,
        [
          ["test", "initializes", 2],
          [
            "suite",
            "increment",
            6,
            [
              ["test", "adds", 7, "only"],
              ["test", "is skipped", 8, "skip"],
              ["test", "also skipped", 9, "skip"],
              ["test", "pending", 10, "skip"],
            ],
          ],
          ["suite", "later", 15, "skip", [["test", "inner", 15]]],
        ],
      ],
      ["test", "top level", 17],
    ]);
  });

  test("Anchor.toml test script, cluster and ports", () => {
    const cfg = anchorConfigFrom(
      parseToml(
        [
          "[toolchain]",
          'package_manager = "yarn"',
          "",
          "[programs.localnet]",
          'demo = "9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1"',
          "",
          "[provider]",
          'cluster = "Localnet" # comment',
          'wallet = "~/.config/solana/id.json"',
          "",
          "[scripts]",
          'test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"',
          "",
          "[test]",
          "startup_wait = 30_000",
          "",
          "[test.validator]",
          "rpc_port = 8999",
        ].join("\n"),
      ),
    );
    assert.deepStrictEqual(cfg.testGlobs, ["tests/**/*.ts"]);
    assert.strictEqual(cfg.localnet, true);
    assert.strictEqual(cfg.rpcPort, 8999);
    assert.strictEqual(cfg.faucetPort, 9900);
    assert.strictEqual(cfg.programs.get("demo"), "9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1");
    assert.strictEqual(anchorConfigFrom(parseToml('[provider]\ncluster = "devnet"')).localnet, false);
    assert.deepStrictEqual(anchorConfigFrom(parseToml("")).testGlobs, ["tests/**/*.{ts,js,mjs,cjs}"]);
  });

  test("test globs from scripts", () => {
    assert.deepStrictEqual(testScriptGlobs("npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/unit/**/*.ts' ./tests/e2e.ts"), [
      "tests/unit/**/*.ts",
      "tests/e2e.ts",
    ]);
    assert.ok(globToRegExp("tests/**/*.ts").test("tests/demo.ts"));
    assert.ok(globToRegExp("tests/**/*.ts").test("tests/a/b/demo.ts"));
    assert.ok(!globToRegExp("tests/**/*.ts").test("tests/demo.js"));
    assert.ok(globToRegExp("tests/**/*.{ts,js}").test("tests/x/demo.js"));
    assert.ok(isMochaScript("yarn run ts-mocha -p ./tsconfig.json tests/**/*.ts"));
    assert.ok(isMochaScript("npx mocha tests"));
    assert.ok(!isMochaScript("cargo test"));
  });
});

suite("Anchor test runs", () => {
  test("mocha options go through bash in one argument that starts with a space", () => {
    const grep = grepFor([
      { path: ["demo", "increment"], kind: "suite" },
      { path: ["demo", "it's (1+1)"], kind: "test" },
    ])!;
    const arg = scriptArgs(["--reporter", "/tmp/my dir/r.cjs", "--grep", grep])!;
    assert.ok(arg.startsWith(" "));
    // anchor runs `bash -c "<script> <args>"`; check bash hands mocha the exact strings.
    const words = execFileSync("bash", ["-c", `printf '%s\\n'${arg}`], { encoding: "utf8" }).trimEnd().split("\n");
    assert.deepStrictEqual(words, ["--reporter", "/tmp/my dir/r.cjs", "--grep", grep]);
    const re = new RegExp(grep);
    assert.ok(re.test("demo increment adds"));
    assert.ok(re.test("demo it's (1+1)"));
    assert.ok(!re.test("demo it's (1+1) more"));
    assert.ok(!re.test("demo incrementer adds"));
  });

  test("reporter markers", () => {
    const pass = parseMarker(`${markerPrefix}{"event":"pass","path":["demo","adds"],"file":"/p/tests/demo.ts","duration":12}`);
    assert.deepStrictEqual(pass, { path: ["demo", "adds"], file: "/p/tests/demo.ts", durationMs: 12, state: "passed" });
    const fail = parseMarker(`${markerPrefix}{"event":"fail","hook":true,"title":"\\"before all\\" hook","path":["demo"],"message":"boom"}`);
    assert.ok(fail !== "end" && fail?.hook === '"before all" hook' && fail.state === "failed");
    assert.strictEqual(parseMarker(`${markerPrefix}{"event":"end"}`), "end");
    assert.strictEqual(parseMarker("hello"), undefined);
  });

  test("spec reporter output from a real anchor test run", () => {
    const results = parseSpec(data("anchor-spec-output.txt"));
    assert.deepStrictEqual(
      results.map((r) => [r.path.join(" > "), r.state, r.durationMs]),
      [
        ["demo > initializes", "passed", 507],
        ["demo > increment > adds", "passed", 514],
        ["demo > increment > fails on purpose", "failed", undefined],
        ["demo > increment > is skipped", "skipped", undefined],
        ["demo > burn > burns compute", "passed", 506],
        ["pure > adds numbers", "passed", undefined],
      ],
    );
    const failed = results[2];
    assert.match(failed.message!, /^count is off by one/);
    assert.match(failed.stack!, /^at \/proj\/tests\/demo\.ts:27:14/);
    assert.deepStrictEqual(stackLocation(failed.stack, "/proj/tests/demo.ts"), { line: 26, col: 13 });
  });

  test("clear reasons for runs that never started", () => {
    assert.match(runProblem("Error: Your configured rpc port: 8899 is already in use")!, /Port 8899 is already in use/);
    assert.match(runProblem("Unable to get latest blockhash. Test validator does not look started.")!, /startup_wait/);
    assert.strictEqual(runProblem("all good"), undefined);
  });
});
