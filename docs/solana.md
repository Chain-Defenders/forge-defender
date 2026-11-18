# Anchor and Solana

## Anchor tests

In a workspace with an `Anchor.toml`, the tests appear in VS Code's **Testing** view under **Anchor**, read from the test
files: `describe` blocks nest, and `it` tests show on their line. Skipped tests (`it.skip`, `xit`) are marked. The files
come from the `test` script in `Anchor.toml`, or `tests/` when the script names none.

Running a test, a `describe` block or a file runs `anchor test` with mocha's `--grep` for just those tests. Results
come in live, with durations, failure messages, expected and actual values, and the failing line.

Running one test on its own runs only that test, so a test that relies on state left by an earlier one fails. That is
how mocha works.

Before a run, ForgeDefender checks that the validator's ports from `Anchor.toml` are free, and says so if a validator
is already running instead of letting `anchor test` fail. It does not start a run that would deploy anywhere except a
local validator: for another cluster it opens a terminal with `anchor test` typed, for you to check and run.

| Setting | Default | |
|---|---|---|
| `forgeDefender.anchor.testArgs` | `[]` | Added to every `anchor test`, such as `["--skip-build"]`. |

## The Solana view

The **Solana** view in the ForgeDefender sidebar shows, per program:

- **Compute units** per instruction from the last test run (`.anchor/program-logs`): highest, average, lowest and number of calls. Instructions above `forgeDefender.solana.computeUnitWarning` (default 100,000) are marked. The default budget is 200,000 per instruction.
- **Program size** of each built `.so` in `target/deploy/`.
- **The IDL**: instructions with their accounts (writable, signer, PDA seeds) and arguments; accounts, types, events, errors and constants. Both the Anchor 0.30+ and the older format are read.

It updates after each test run and when a build changes.

## PDA helper

**ForgeDefender: Find Program Derived Address (PDA)** asks for a program ID and seeds, and shows the address and bump.
Seeds use the Solana CLI's syntax:

| Seed | Example |
|---|---|
| A string | `string:vault` |
| A public key | `pubkey:9SvstZYjDdqRocjYKR47Cr87UVdnzbqM5w3xGnBwT9B1` |
| Bytes | `hex:0a0b` |
| A number, little-endian | `u64:42`, also `u8`, `u16`, `u32`, `u128` and `i*` |
| A number, big-endian | `u64be:42` |

## Deploy and the validator

Starting and stopping `solana-test-validator`, and `anchor deploy`, are in [Chain and deploys](chain.md).
