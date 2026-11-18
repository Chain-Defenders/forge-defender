import * as assert from "node:assert";
import { base58Decode, base58Encode } from "../../src/solana/base58";
import { findProgramAddressFor, parseSeed, splitSeeds } from "../../src/solana/pda";

// Expected addresses come from `solana find-program-derived-address` (solana-cli 2.2.20).

suite("Solana PDA", () => {
  test("base58 round-trips, keeping leading zeros", () => {
    for (const s of ["11111111111111111111111111111111", "9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1", "1", "1112"]) {
      assert.strictEqual(base58Encode(base58Decode(s)), s);
    }
    assert.deepStrictEqual([...base58Decode("11111111111111111111111111111111")], new Array(32).fill(0));
    assert.throws(() => base58Decode("0OIl"));
  });

  test("associated token account (seeds: owner, token program, mint)", () => {
    const pda = findProgramAddressFor("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", [
      "pubkey:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "pubkey:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "pubkey:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ]);
    assert.deepStrictEqual(pda, { address: "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B", bump: 254 });
  });

  test("string and pubkey seeds, as an Anchor counter PDA", () => {
    const pda = findProgramAddressFor("9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1", [
      "string:counter",
      "pubkey:C7LEqdJv142KNBW1MhQSWuipkcCuCggi2UYzNMqNw2b7",
    ]);
    assert.deepStrictEqual(pda, { address: "44C2WTSE36nuUPM3cp2VLfdQMH8AoNe4PtTqgMuGoVSW", bump: 254 });
  });

  test("integer and hex seeds, little-endian by default", () => {
    const pda = findProgramAddressFor("9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1", [
      "string:counter",
      "u8:7",
      "u16:513",
      "u32le:70000",
      "u64:1234567890123",
      "hex:deadbeef",
    ]);
    assert.deepStrictEqual(pda, { address: "6okbgVEnjGJQr6YdHjRmDqhcf4vD93z9E9NtLP79uZ4X", bump: 253 });
  });

  test("big-endian and signed seeds", () => {
    const pda = findProgramAddressFor("11111111111111111111111111111111", ["u64be:5", "i32le:-2", "u16be:300"]);
    assert.deepStrictEqual(pda, { address: "3jmVQNC6E7SVq1hxwQ7A8puKABKGX6vEjYgc7djkhJ9T", bump: 253 });
  });

  test("no seeds, and a quoted string with a space", () => {
    assert.deepStrictEqual(findProgramAddressFor("9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1", []), {
      address: "KF27ur3Kk5LCLztQhjxf1J8KVtAgJYkXgxbmzxxSs5K",
      bump: 251,
    });
    const seeds = splitSeeds('string:"hello world"');
    assert.deepStrictEqual(seeds, ["string:hello world"]);
    assert.deepStrictEqual(findProgramAddressFor("9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1", seeds), {
      address: "J6AG7owBpDyNbMz6ydhvhYNzmdQJdBxoEhnuBgWtDiBz",
      bump: 254,
    });
  });

  test("rejects bad seeds with a reason", () => {
    assert.throws(() => parseSeed("u8:256"), /does not fit/);
    assert.throws(() => parseSeed("hex:abc"), /not hex/);
    assert.throws(() => parseSeed("counter"), /type:value/);
    assert.throws(() => parseSeed("pubkey:abc"), /not a public key/);
    assert.throws(() => findProgramAddressFor("11111111111111111111111111111111", [`string:${"x".repeat(33)}`]), /at most 32/);
  });
});
