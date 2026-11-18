import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checksumAddress, selector } from "../../src/core/abi";
import type { Artifact } from "../../src/core/artifacts";
import { parseBroadcast, readDeployments } from "../../src/chain/broadcast";
import { addressUrl, anvilAccounts, chainInfo, expandEnv, redactUrl, shownArgs, txUrl } from "../../src/chain/chains";
import { argsFromCast, buildIndex, decodeWith, normaliseHex, panicMeaning, renderDecoded } from "../../src/chain/decode";
import { commandLine, quote, shellKindOf } from "../../src/chain/shell";
import { canonicalElementary, matchAbiEntry, signatureFromSource } from "../../src/chain/signatures";
import { judgeSize, parseSizes } from "../../src/chain/sizes";

const root = path.resolve(__dirname, "../../..");
const sample = fs.readFileSync(path.join(root, "test/fixtures/chain/run-latest.json"), "utf8");

suite("Chain: broadcast files", () => {
  test("reads a real forge 1.9 run-latest.json", () => {
    const d = parseBroadcast(sample, "Deploy.s.sol", 31337);
    assert.deepStrictEqual(d, [
      {
        contractName: "Counter",
        address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        txHash: "0xadcca7f434844bdf50db68e063705a67963edfdd3636672aad3f5cc22d8a13cf",
        chainId: 31337,
        script: "Deploy.s.sol",
        time: 1794954081761,
        kind: "CREATE",
      },
    ]);
  });

  test("skips failed transactions, reads seconds and contracts created by others", () => {
    const json = JSON.stringify({
      transactions: [
        { hash: "0x1", transactionType: "CREATE", contractName: "A", contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3" },
        {
          hash: "0x2",
          transactionType: "CALL",
          contractName: "Factory",
          contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
          additionalContracts: [{ transactionType: "CREATE2", contractName: "Child", address: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512" }],
        },
        { hash: "0x3", transactionType: "CREATE2", contractName: "B", contractAddress: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" },
      ],
      receipts: [{ transactionHash: "0x3", status: "0x0" }],
      timestamp: 1700000000,
      chain: 1,
    });
    const d = parseBroadcast(json, "X.s.sol", 999);
    assert.deepStrictEqual(
      d.map((x) => [x.contractName, x.kind, x.chainId, x.time]),
      [
        ["A", "CREATE", 1, 1700000000000],
        ["Child", "additional", 1, 1700000000000],
      ],
    );
  });

  test("walks the broadcast folder and skips dry runs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-broadcast-"));
    try {
      fs.mkdirSync(path.join(dir, "Deploy.s.sol/31337/dry-run"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Deploy.s.sol/31337/run-latest.json"), sample);
      fs.writeFileSync(path.join(dir, "Deploy.s.sol/31337/dry-run/run-latest.json"), sample);
      fs.mkdirSync(path.join(dir, "Bad.s.sol/1"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Bad.s.sol/1/run-latest.json"), "{not json");
      const errors: string[] = [];
      const d = readDeployments(dir, (f) => errors.push(f));
      assert.strictEqual(d.length, 1);
      assert.strictEqual(errors.length, 1);
      assert.deepStrictEqual(readDeployments(path.join(dir, "missing")), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite("Chain: chains and URLs", () => {
  test("names chains and builds explorer links", () => {
    assert.strictEqual(chainInfo(1).name, "Ethereum");
    assert.strictEqual(chainInfo(424242).name, "Chain 424242");
    const a = "0x" + "ab".repeat(20);
    assert.strictEqual(addressUrl(8453, a), `https://basescan.org/address/${a}`);
    assert.strictEqual(addressUrl(31337, a), undefined);
  });

  test("Anvil's dev accounts are checksummed and match anvil's eth_accounts", () => {
    // From `cast rpc eth_accounts` against anvil 1.9.
    const fromAnvil = [
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
      "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
      "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
      "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
      "0x976ea74026e726554db657fa54763abd0c3a0aa9",
      "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
      "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
      "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
    ];
    assert.deepStrictEqual(anvilAccounts, fromAnvil.map(checksumAddress));
  });

  test("redacts keys in paths and queries", () => {
    assert.strictEqual(redactUrl("https://eth-mainnet.g.alchemy.com/v2/SECRETKEY"), "https://eth-mainnet.g.alchemy.com/…");
    assert.strictEqual(redactUrl("https://rpc.example.org/?apikey=SECRET"), "https://rpc.example.org/…");
    assert.strictEqual(shownArgs(["test", "--fork-url", "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY", "--fork-url=wss://x.io/k"]), "test --fork-url https://eth-mainnet.g.alchemy.com/… --fork-url=wss://x.io/…");
    assert.strictEqual(txUrl(1, "0xab`](https://evil)"), undefined);
    assert.strictEqual(addressUrl(1, "0x" + "1".repeat(40) + "/x"), undefined);
    assert.strictEqual(redactUrl("http://127.0.0.1:8545"), "http://127.0.0.1:8545");
    assert.strictEqual(redactUrl("${MAINNET_RPC}"), "(a URL)");
  });

  test("fills ${VAR} from the environment and reports what is missing", () => {
    assert.deepStrictEqual(expandEnv("https://x/v2/${KEY}", { KEY: "k" }), { value: "https://x/v2/k", missing: [] });
    assert.deepStrictEqual(expandEnv("${A}/${B}", {}).missing, ["A", "B"]);
  });
});

suite("Chain: shell command lines", () => {
  test("quotes for POSIX shells", () => {
    assert.strictEqual(quote("script/Deploy.s.sol:DeployScript", "posix"), "script/Deploy.s.sol:DeployScript");
    assert.strictEqual(quote("it's $HOME; rm -rf /", "posix"), `'it'\\''s $HOME; rm -rf /'`);
    assert.strictEqual(quote({ env: "FORGE_DEFENDER_RPC_URL" }, "posix"), `"$FORGE_DEFENDER_RPC_URL"`);
    assert.strictEqual(commandLine(["forge", "script", "a b.s.sol:X", "--rpc-url", { env: "U" }], "posix"), `forge script 'a b.s.sol:X' --rpc-url "$U"`);
  });

  test("quotes for PowerShell and cmd", () => {
    assert.strictEqual(quote("a'b c", "powershell"), "'a''b c'");
    assert.strictEqual(quote("x\u2019;calc;\u2018.s.sol", "powershell"), "'x\u2019\u2019;calc;\u2018\u2018.s.sol'");
    assert.strictEqual(quote({ env: "U" }, "powershell"), "$env:U");
    assert.strictEqual(commandLine(["C:\\Program Files\\forge.exe", "build"], "powershell"), "& 'C:\\Program Files\\forge.exe' build");
    assert.strictEqual(quote({ env: "U" }, "cmd"), "%U%");
  });

  test("tells shells apart", () => {
    assert.strictEqual(shellKindOf("/bin/zsh", "darwin"), "posix");
    assert.strictEqual(shellKindOf("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
    assert.strictEqual(shellKindOf("C:\\Windows\\System32\\cmd.exe", "win32"), "cmd");
    assert.strictEqual(shellKindOf("C:\\Program Files\\Git\\bin\\bash.exe", "win32"), "posix");
  });
});

suite("Chain: contract sizes", () => {
  test("reads forge 1.9's --sizes --json", () => {
    const out = `{"Counter":{"runtime_size":908,"init_size":1000,"runtime_margin":23668,"init_margin":48152},"DeployScript":{"runtime_size":1583,"init_size":1611,"runtime_margin":22993,"init_margin":47541}}\n`;
    const s = parseSizes(out);
    assert.deepStrictEqual(s.get("Counter"), { runtime: 908, init: 1000 });
    assert.strictEqual(s.size, 2);
    assert.throws(() => parseSizes("Error: compilation failed"));
  });

  test("warns from 90% and errors over the limits", () => {
    assert.strictEqual(judgeSize("A", { runtime: 22_000, init: 23_000 }), undefined);
    const w = judgeSize("A", { runtime: 22_119, init: 23_000 })!;
    assert.strictEqual(w.severity, "warning");
    assert.match(w.message, /^A: Runtime code is 22,119 bytes, 90% of the 24,576-byte limit \(EIP-170\)\.$/);
    const e = judgeSize("B", { runtime: 24_577, init: 50_000 })!;
    assert.strictEqual(e.severity, "error");
    assert.match(e.message, /1 over the 24,576-byte limit \(EIP-170\)/);
    assert.match(e.message, /Initcode is 50,000 bytes, 848 over the 49,152-byte limit \(EIP-3860\)/);
    assert.strictEqual(judgeSize("C", { runtime: 24_576, init: 49_152 })!.severity, "warning");
  });
});

suite("Chain: signatures from source", () => {
  test("canonical elementary types", () => {
    assert.strictEqual(canonicalElementary("uint"), "uint256");
    assert.strictEqual(canonicalElementary("int[]"), "int256[]");
    assert.strictEqual(canonicalElementary("bytes32[2][]"), "bytes32[2][]");
    assert.strictEqual(canonicalElementary("IERC20"), undefined);
    assert.strictEqual(signatureFromSource("f", ["uint", "address", "bytes"]), "f(uint256,address,bytes)");
    assert.strictEqual(signatureFromSource("g", ["Order"]), undefined);
  });

  test("picks the right overload from the ABI", () => {
    const abi = [
      { type: "function" as const, name: "f", inputs: [{ name: "a", type: "uint256" }] },
      { type: "function" as const, name: "f", inputs: [{ name: "a", type: "address", internalType: "contract IERC20" }] },
      { type: "function" as const, name: "f", inputs: [{ name: "a", type: "tuple", internalType: "struct Lib.Order", components: [{ name: "x", type: "uint8" }] }] },
      { type: "function" as const, name: "f", inputs: [{ name: "a", type: "uint256" }, { name: "b", type: "bool" }] },
      { type: "error" as const, name: "E", inputs: [] },
    ];
    assert.strictEqual(matchAbiEntry(abi, "function", "f", ["uint"]), abi[0]);
    assert.strictEqual(matchAbiEntry(abi, "function", "f", ["IERC20"]), abi[1]);
    assert.strictEqual(matchAbiEntry(abi, "function", "f", ["Lib.Order"]), abi[2]);
    assert.strictEqual(matchAbiEntry(abi, "function", "f", ["uint256", "bool"]), abi[3]);
    assert.strictEqual(matchAbiEntry(abi, "error", "E", []), abi[4]);
    assert.strictEqual(matchAbiEntry(abi, "error", "E", ["uint256"]), undefined);
    assert.strictEqual(matchAbiEntry(abi, "event", "E", []), undefined);
  });
});

suite("Chain: decoding", () => {
  const counter: Artifact = {
    name: "Counter",
    source: "src/Counter.sol",
    file: "",
    methodIdentifiers: {},
    deployedBytecode: "",
    abi: [
      { type: "function", name: "setNumber", inputs: [{ name: "newNumber", type: "uint256" }] },
      { type: "function", name: "many", inputs: [{ name: "xs", type: "uint256[]" }] },
      { type: "error", name: "TooBig", inputs: [{ name: "value", type: "uint256" }] },
      { type: "event", name: "Set", inputs: [{ name: "value", type: "uint256", indexed: true }] },
    ],
  };
  const word = (n: number) => n.toString(16).padStart(64, "0");

  test("indexes functions and errors with the built-ins", () => {
    const index = buildIndex([counter, { ...counter, name: "Counter2" }]);
    assert.deepStrictEqual(index.get("0x3fb5c1cb")?.map((k) => [k.signature, k.from]), [["setNumber(uint256)", ["Counter", "Counter2"]]]);
    assert.strictEqual(index.get(selector("TooBig(uint256)"))?.[0].kind, "error");
    assert.strictEqual(index.get("0x08c379a0")?.[0].signature, "Error(string)");
    assert.strictEqual(index.get(selector("Set(uint256)")), undefined);
  });

  test("decodes calldata, Error(string) and Panic(uint256)", () => {
    const index = buildIndex([counter]);
    const call = normaliseHex("0x3fb5c1cb" + word(42))!;
    assert.deepStrictEqual(decodeWith(index.get("0x3fb5c1cb")![0], call).args, [{ name: "newNumber", type: "uint256", value: "42" }]);

    const msg = Buffer.from("too big").toString("hex").padEnd(64, "0");
    const err = "08c379a0" + word(32) + word(7) + msg;
    assert.strictEqual(decodeWith(index.get("0x08c379a0")![0], err).args?.[0].value, "too big");

    const panic = decodeWith(index.get("0x4e487b71")![0], "4e487b71" + word(0x11));
    assert.strictEqual(panic.note, "Panic 0x11: arithmetic overflow or underflow");
    assert.strictEqual(panicMeaning(0x99n), "unknown panic code");
  });

  test("leaves arrays to cast and reads its output", () => {
    const known = buildIndex([counter]).get(selector("many(uint256[])"))![0];
    assert.strictEqual(decodeWith(known, selector("many(uint256[])").slice(2) + word(32) + word(1) + word(5)).args, undefined);
    assert.deepStrictEqual(argsFromCast(known, "[5]\n"), [{ name: "xs", type: "uint256[]", value: "[5]" }]);
    assert.strictEqual(argsFromCast(known, ""), undefined);
  });

  test("normalises hex and renders a readable document", () => {
    assert.strictEqual(normaliseHex(" 0X3FB5 C1CB "), "3fb5c1cb");
    assert.strictEqual(normaliseHex("0x3fb5c1"), undefined);
    assert.strictEqual(normaliseHex("zz5c1cb0"), undefined);
    const hex = "deadbeef" + word(1);
    const doc = renderDecoded(hex, []);
    assert.match(doc, /Selector: `0xdeadbeef`/);
    assert.match(doc, /not in the project's contracts/);
    assert.ok(doc.includes("0xdeadbeef\n" + word(1)));
  });
});
