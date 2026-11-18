# Security checks

Four checks that catch the kinds of problems auditors find, while you write the code. All of them run on your machine;
none sends code anywhere.

## Storage layout and upgrades

Upgrading a proxied contract with a changed storage layout corrupts its state. ForgeDefender compares a contract's
layout with a saved **baseline** and says what moved.

1. Above every contract that looks upgradeable (it inherits `Initializable`, `UUPSUpgradeable` and the like), a lens offers **Save storage baseline**. The baseline goes to `.forgedefender/storage/<source path>/<Contract>.json`. Commit it with the release.
2. After each test run, and with **ForgeDefender: Check Storage Layouts Against Baselines**, every contract with a baseline is checked. Problems appear on the contract's line:

| Found | Shown as |
|---|---|
| A variable removed | Error |
| A variable's type changed (size or type) | Error |
| A variable moved to another slot or offset | Error |
| A new variable inserted where existing storage was | Error |
| A member added, removed or changed in a struct stored inline or in an array | Error |
| A variable renamed at the same slot | Warning |

These are fine and not reported: new variables after the existing ones; shrinking an OpenZeppelin-style `__gap` by
exactly the slots the new variables take; a member added at the end of a struct used only as a mapping value.

**ForgeDefender: Show Storage Layout** shows the layout of the contract under the cursor as a table, with struct members.

The layout comes from `forge inspect <file>:<Contract> storageLayout`.

| Setting | Default | |
|---|---|---|
| `forgeDefender.security.storage.checkAfterTests` | `true` | Check after each test run, when baselines exist. |
| `forgeDefender.security.storage.codeLens` | `true` | The lens above upgradeable contracts. |

## Known-bad dependencies

ForgeDefender checks the versions of your dependencies against published security advisories and marks the line
that brings each one in:

- **Foundry:** git submodules in `lib/` (version from the package's `package.json` or its git tag), Soldeer dependencies (`dependencies/` and `foundry.toml`), and npm packages (`node_modules/` or `package.json`).
- **Anchor:** `Cargo.lock`, shown on the line in `Cargo.toml` that declares the crate.

Each problem names the advisory, its severity and the first fixed version, and links to it. The **Dependencies** view in
the sidebar lists what was found. **ForgeDefender: Check Dependencies for Known Advisories** checks again.

The advisories ship with the extension, taken from the GitHub Advisory Database for: `@openzeppelin/contracts`,
`@openzeppelin/contracts-upgradeable`, `solady`, `solmate`, `anchor-lang`, `anchor-spl`, `solana-program`, `spl-token`
and `spl-token-2022`. Each release updates them; the date of the list is in the Dependencies view. No network is used.

## Static analysis

**ForgeDefender: Run Static Analysis** runs [Slither](https://github.com/crytic/slither) or
[Aderyn](https://github.com/Cyfrin/aderyn), whichever you have installed, and puts the findings in the editor and the
Problems panel, each with its severity and a link to the detector's description. Findings that are only in dependencies
(`lib/`, `node_modules/`, `dependencies/`) are left out.

ForgeDefender does not install either tool; each one's README explains how.

| Setting | Default | |
|---|---|---|
| `forgeDefender.security.analysis.engine` | `auto` | `slither`, `aderyn`, or `auto`: Slither if installed, else Aderyn. |
| `forgeDefender.security.analysis.onSave` | `false` | Run again a second after each save. |

## Audit readiness

**ForgeDefender: Show Audit Readiness Report** answers "is this ready for an audit, and how big is it?":

- the files in scope (under `src/`) with their nSLOC and the total; interfaces and mocks are listed separately and not counted;
- line, branch and function coverage of those files;
- functions no test ever ran;
- public and external functions without NatSpec;
- floating pragmas (`^0.8.20`) and TODO/FIXME comments;
- the last test run's passes and failures.

**ForgeDefender: Write scope.txt** writes the list of in-scope files, the form most auditors ask for.

nSLOC here counts lines that are neither blank nor only a comment.

Coverage comes from the last coverage run; if there is none, the report offers to run one.

The **Audit Readiness** view in the sidebar shows the same numbers in short.

The report ends with a link to an audit estimate from Chain Defenders, and, for projects of up to 4,000 nSLOC while the
current round is open, a link to its audit grant. There are no pop-ups.
