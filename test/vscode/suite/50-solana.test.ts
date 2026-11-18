import * as assert from "node:assert";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, waitFor, workspace } from "./helpers";

// The Anchor fixture has tests but no build output; the tools view tests write the files anchor would leave.

const anchorRoot = path.join(workspace, "anchor");
const demo = "9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1";
const unitData = path.resolve(__dirname, "../../../../test/unit/data");

interface Dumped {
  id: string;
  label: string;
  line?: number;
  tags: string[];
  children: Dumped[];
}
interface ViewNode {
  label: string;
  description?: string;
  icon?: string;
  children?: ViewNode[];
}
interface RunSummary {
  results: Record<string, { state: string; message?: string }>;
  output: string;
  problem?: string;
}

const flatten = (items: Dumped[]): Dumped[] => items.flatMap((i) => [i, ...flatten(i.children)]);
const discovered = () => vscode.commands.executeCommand<Dumped[]>("forgeDefender.anchor.discoveredTests");
const fileItem = async (file: string) => flatten(await discovered()).find((i) => i.id === `file:${file}`);

suite("Solana: Anchor tests", () => {
  const demoFile = path.join(anchorRoot, "tests", "demo.js");

  test("discovers suites and tests with lines and skips", async () => {
    await activate();
    const file = await waitFor(() => fileItem(demoFile), "the Anchor test file", 30_000);
    assert.strictEqual(file.label, path.join("tests", "demo.js"));
    const shape = (i: Dumped): unknown => [i.label, i.line, ...i.tags, ...i.children.map(shape)];
    assert.deepStrictEqual(file.children.map(shape), [
      ["demo", 3, ["initializes", 6], ["increment", 10, ["adds", 11], ["is skipped", 13, "skip"]]],
    ]);
    // Files outside the Anchor.toml test glob, or without tests, are not listed.
    assert.strictEqual(await fileItem(path.join(anchorRoot, "tests", "helpers", "util.js")), undefined);
  });

  test("picks up a test file created and deleted in the editor", async () => {
    await activate();
    const added = path.join(anchorRoot, "tests", "added.js");
    const create = new vscode.WorkspaceEdit();
    create.createFile(vscode.Uri.file(added), { contents: Buffer.from('describe("added", () => { it("works", () => {}); });\n') });
    assert.ok(await vscode.workspace.applyEdit(create));
    try {
      const file = await waitFor(() => fileItem(added), "the new test file", 60_000);
      assert.deepStrictEqual(flatten(file.children).map((i) => i.label), ["added", "works"]);
    } finally {
      const remove = new vscode.WorkspaceEdit();
      remove.deleteFile(vscode.Uri.file(added));
      await vscode.workspace.applyEdit(remove);
    }
    await waitFor(async () => !(await fileItem(added)), "the removed test file to go", 60_000);
  });

  test("reports a validator left running on the port instead of starting anchor", async () => {
    // The fixture's Anchor.toml puts the validator on port 18899.
    await activate();
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(18899, "127.0.0.1", r));
    try {
      const file = (await fileItem(demoFile))!;
      const adds = flatten(file.children).find((i) => i.label === "adds")!;
      const summary = await vscode.commands.executeCommand<RunSummary>("forgeDefender.anchor.runTests", [adds.id]);
      assert.match(summary.problem ?? "", /Port 18899 is already in use/);
      assert.deepStrictEqual(Object.values(summary.results).map((r) => r.state), ["errored"]);
      assert.ok(!summary.output.includes("> anchor test"), "anchor must not be started");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // Runs a real `anchor test` when FORGEDEFENDER_ANCHOR_PROJECT names a built Anchor project linked into the
  // fixtures as test/fixtures/real-anchor; skipped otherwise.
  test("runs a real project with per-test results", async function () {
    const real = path.join(workspace, "real-anchor");
    if (!process.env.FORGEDEFENDER_ANCHOR_PROJECT || !fs.existsSync(real)) return this.skip();
    this.timeout(600_000);
    await activate();
    const file = await waitFor(() => fileItem(path.join(real, "tests", "demo.ts")), "the real project's tests");
    const all = flatten(await discovered());
    const full = await vscode.commands.executeCommand<RunSummary>("forgeDefender.anchor.runTests", [file.id]);
    console.log(JSON.stringify(full.results, null, 1));
    const byLabel = (s: RunSummary, label: string) => Object.entries(s.results).find(([id]) => (JSON.parse(id) as string[]).at(-1) === label)?.[1];
    assert.strictEqual(byLabel(full, "initializes")?.state, "passed");
    assert.strictEqual(byLabel(full, "fails on purpose")?.state, "failed");
    assert.match(byLabel(full, "fails on purpose")?.message ?? "", /count is off by one/);
    assert.strictEqual(byLabel(full, "is skipped")?.state, "skipped");
    assert.match(full.output, /hello from pure|ok burns compute/);

    // A single test: only it runs.
    const pure = flatten(all.find((i) => i.id === `file:${path.join(real, "tests", "other.ts")}`)!.children).find((i) => i.label === "adds numbers")!;
    const one = await vscode.commands.executeCommand<RunSummary>("forgeDefender.anchor.runTests", [pure.id]);
    console.log(JSON.stringify(one.results, null, 1));
    assert.deepStrictEqual(Object.values(one.results).map((r) => r.state), ["passed"]);
    assert.match(one.output, /--grep/);
  });
});

suite("Solana: tools view", () => {
  const view = () => vscode.commands.executeCommand<ViewNode[]>("forgeDefender.solana.viewState");
  const section = (nodes: ViewNode[], label: string) => {
    // With more than one Anchor project, sections sit under each project.
    const own = nodes.find((n) => n.label === "anchor")?.children ?? nodes;
    return own.find((n) => n.label === label)!;
  };

  test("shows compute units, sizes and the IDL from anchor's output", async () => {
    await activate();
    fs.mkdirSync(path.join(anchorRoot, ".anchor", "program-logs"), { recursive: true });
    fs.mkdirSync(path.join(anchorRoot, "target", "deploy"), { recursive: true });
    fs.mkdirSync(path.join(anchorRoot, "target", "idl"), { recursive: true });
    fs.copyFileSync(path.join(unitData, "program-log.txt"), path.join(anchorRoot, ".anchor", "program-logs", `${demo}.demo.log`));
    fs.writeFileSync(path.join(anchorRoot, "target", "deploy", "demo.so"), Buffer.alloc(212432));
    fs.copyFileSync(path.join(unitData, "idl-demo.json"), path.join(anchorRoot, "target", "idl", "demo.json"));
    await vscode.workspace.getConfiguration("forgeDefender").update("solana.computeUnitWarning", 10000, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand("forgeDefender.solana.refresh");
      const nodes = await view();
      const cu = section(nodes, "Compute units");
      assert.deepStrictEqual(
        cu.children!.map((c) => [c.label, c.description, c.icon]),
        [
          ["Burn", "17,138 CU", "warning"],
          ["Initialize", "8,569 CU", "symbol-event"],
          ["Increment", "3,403 CU", "symbol-event"],
        ],
      );
      assert.strictEqual(cu.description, "1 over 10,000");
      assert.deepStrictEqual(section(nodes, "Program sizes").children!.map((c) => [c.label, c.description]), [["demo.so", "207.5 KB"]]);
      const idl = section(nodes, "IDL").children![0];
      assert.deepStrictEqual([idl.label, idl.description], ["demo", demo]);
      assert.deepStrictEqual(
        idl.children!.map((c) => c.label),
        ["Instructions", "Accounts", "Types", "Events", "Errors"],
      );
    } finally {
      await vscode.workspace.getConfiguration("forgeDefender").update("solana.computeUnitWarning", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("PDA command derives the address the Solana CLI gives", async () => {
    const pda = await vscode.commands.executeCommand<{ address: string; bump: number }>("forgeDefender.solana.findPda", demo, [
      "string:counter",
      "pubkey:C7LEqdJv142KNBW1MhQSWuipkcCuCggi2UYzNMqNw2b7",
    ]);
    assert.deepStrictEqual(pda, { address: "44C2WTSE36nuUPM3cp2VLfdQMH8AoNe4PtTqgMuGoVSW", bump: 254 });
  });
});
