# Changelog

## 2.0.3

- A new icon that also shows on light themes.

## 2.0.2

- KeyMoat is now written KeyMoat in the sidebar, the commands and the docs. Its download is on [GitHub](https://github.com/Chain-Defenders/keymoat/releases/latest).

## 2.0.1

- Starts reliably in large repositories. VS Code gives up looking for a `foundry.toml` after a few seconds, so ForgeDefender now also starts when VS Code has finished starting and looks for projects itself.
- New setting `forgeDefender.projects`: the project folders to use instead of searching. A folder without a `foundry.toml` is run as a Foundry project with forge's defaults.
- The sidebar shows only in a workspace with a Foundry or Anchor project.
- After updating from 1.x, run **Developer: Reload Window** if the sidebar says "There is no data provider registered".

## 2.0.0

A rewrite. ForgeDefender now covers Foundry and Anchor projects from tests to deploys.

### Tests
- Foundry tests in VS Code's own Testing view instead of a custom tree, with inherited tests, continuous run, and a test tree read from the sources.
- Gas per test, compared with `.gas-snapshot`; Update Gas Snapshot.
- Failures on the line of the failing `require` or `assert`, with fuzz counterexamples and invariant sequences.
- Add as Regression Test: turns a fuzz or invariant failure into a test that replays it.
- Call traces in a tree view, linked to the code.
- Coverage in VS Code's coverage view.
- Build errors in the editor and the Problems panel.
- Debug in terminal (`forge test --debug`).
- Anchor tests in the Testing view, with compute units.

### Security
- Storage layout check against saved baselines for upgradeable contracts.
- Known-bad dependency versions, from the GitHub Advisory Database.
- Slither or Aderyn findings in the editor.
- Audit readiness report and `scope.txt`.
- KeyMoat view: whether tools run sandboxed, plain-text keys, blocked connections.

### Chain
- Start, fork, reset and stop Anvil and the Solana test validator.
- Dry-run and deploy scripts in a terminal; Anchor deploy.
- Deployments view from `broadcast/`, with explorer links and verification.
- Contract size warnings (EIP-170, EIP-3860).
- Selector hovers and a calldata and revert decoder.
- Solana program sizes, IDL viewer and PDA helper.

### Removed
- The old settings (`testDirectories`, `excludePatterns`, `runBuildBeforeTests`, `runNpmInstallBeforeTests`, `autoRun`, `showGasUsage`, `verboseOutput`). Test folders now come from `foundry.toml`, and ForgeDefender no longer runs `npm install`.

## 1.1.2 and earlier

A test tree for Foundry projects.
