# Chain and deploys

## Local chain

The **Local chain** view in the ForgeDefender sidebar starts and stops a local node in a VS Code terminal.

- **Start Anvil** runs `anvil` on `forgeDefender.chain.port` (default 8545). The view shows the chain ID, the block number and the ten dev accounts; clicking an account copies its address.
- **Fork a network** starts Anvil with `--fork-url`. Pick one of the project's `rpc_endpoints` from `foundry.toml`, or paste a URL. A pasted URL reaches Anvil through an environment variable, so its API key is not on the command line, and the view shows only its host.
- **Reset** sends `anvil_reset`, back to block 0 (or the fork block).
- **Stop** closes the terminal. A node that was already running on the port is shown as "not started from VS Code", and ForgeDefender does not stop it.

In an Anchor workspace the view also starts and stops `solana-test-validator`, with its ledger in `.anchor/test-ledger`.

## Deploy from the editor

In a script (`*.s.sol` under the script folder), lenses above `run()` offer:

- **Dry run**: `forge script` without `--broadcast`. Nothing is sent.
- **Deploy…**: choose the network, then the signer, then whether to verify.

| Network | |
|---|---|
| An `rpc_endpoints` alias | Passed to forge as the alias, so the URL stays in your config. |
| Local Anvil | Offers to start it if it is not running. |
| A URL | Passed through an environment variable. |

| Signer | |
|---|---|
| A Foundry keystore | `--account NAME`, from `cast wallet list`. forge asks for its password in the terminal. |
| Ledger or Trezor | `--ledger` / `--trezor`. |
| Anvil test account 0 | Local Anvil only: `--unlocked`, no key involved. |

Every deploy runs in a terminal you can see. There is no private key option, and ForgeDefender never reads a key.
To make a keystore: `cast wallet import NAME --interactive`.

Only `run()` without parameters gets the lenses; for a `run(args)` script, run `forge script --sig` yourself.

**ForgeDefender: Deploy the Anchor program…** runs `anchor deploy --provider.cluster CLUSTER` in a terminal, and asks
again before mainnet.

## Deployments

The **Deployments** view lists what your scripts deployed, from `broadcast/<Script>/<chain>/run-latest.json`, grouped
by chain. Dry runs and failed transactions are left out; contracts created by other contracts are included.

For each contract: copy the address or the transaction hash, open it in the chain's block explorer, or **Verify**, which
runs `forge verify-contract` in a terminal. The view updates when a script writes a new broadcast.

## Contract size

After each test run, and with **ForgeDefender: Check contract sizes**, ForgeDefender runs `forge build --sizes` and marks
the contract's line:

| | Runtime code (EIP-170) | Init code (EIP-3860) |
|---|---|---|
| Limit | 24,576 bytes | 49,152 bytes |
| Warning from | 90% | 90% |
| Error | over the limit | over the limit |

Test and script contracts are not checked.

## Selectors and decoding

Hover a function, error or event declaration to see its signature and its selector (or its event topic).

**ForgeDefender: Decode calldata or revert data** takes hex and decodes it against every function and error in the
project's build, plus `Error(string)` and `Panic(uint256)` with the panic's meaning. If the selector is not in the
project, ForgeDefender asks before looking it up online with `cast 4byte-calldata`.

## Settings

| Setting | Default | |
|---|---|---|
| `forgeDefender.chain.port` | `8545` | The local Anvil port. |
| `forgeDefender.sizes.afterTests` | `true` | Check sizes after each test run. |
