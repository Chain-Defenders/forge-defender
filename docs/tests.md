# Foundry tests

ForgeDefender puts Foundry tests in VS Code's own **Testing** view (the flask icon). Run, re-run failed, filter, the
play buttons in the editor's gutter and the keyboard shortcuts all work the standard way.

## The tree

The tree is read from your sources, so it is there before anything compiles:

- every `.sol` file under the test folder from `foundry.toml` (default `test/`), plus `*.t.sol` files under the source folder;
- per file, each contract that is not `abstract` and has tests;
- per contract, its tests: public or external functions whose names start with `test`, `invariant` or `statefulFuzz`, **including the ones it inherits**. An inherited test shows `from BaseTest` and opens in the base's file.

When forge reports a test the tree does not have, it is added. Saving a `.sol` file updates the tree.

A workspace with several Foundry projects (a `foundry.toml` each) gets one top-level entry per project. To pick them yourself, use the `forgeDefender.projects` setting (see the [README](../README.md)).

## Running

| What you run | What forge runs |
|---|---|
| Everything | `forge test --json` |
| A file or a contract | `forge test --json --match-path FILE --match-contract ^NAME$` |
| Some tests | the same, plus `--match-test` for just those tests |

There is no separate build or install step: forge builds what changed.

Each result shows:

- **Gas** next to the test in the tree and at the end of its line in the editor. Fuzz tests show mean gas.
- **Failures** with forge's reason, on the line of the `require` or `assert` whose message matches, or on the test's line.
- **Counterexamples** for fuzz and invariant failures: the inputs, or the sequence of calls.
- **Logs** (`console.log`) in the test's output.

A build error fails the run with the compiler's message, and puts the error on its line in the editor and in the Problems panel.

**Continuous run** (the eye icon in the Testing view) runs the chosen tests again every time you save a `.sol` file.

## Gas changes

If the project has a `.gas-snapshot` (written by `forge snapshot`), each result is compared with it:

```
52,203 gas (+312, +0.6%)
```

Tests that got more expensive by more than `forgeDefender.gas.warnPercent` (default 1%) are highlighted in the editor.
**ForgeDefender: Update Gas Snapshot** runs `forge snapshot` to take a new one.

## Regression tests from fuzz failures

When a fuzz or invariant test fails, right-click the failure message (or the test) and choose **Add as Regression
Test**. ForgeDefender writes an ordinary test into the same contract that replays exactly what failed:

```solidity
/// Regression: testFuzz_SetNumber failed with 742886487892369547698386939959150855759913659.
function test_Regression_testFuzz_SetNumber_1() public {
    testFuzz_SetNumber(742886487892369547698386939959150855759913659);
}
```

For an invariant it replays the call sequence (sender, target and calldata of each call), then checks the invariant.
Inputs of simple types are written as values; arrays and structs are replayed as the original calldata. Without
forge-std, the cheatcodes are called by their address, so no import is needed.

The new test fails the same way until the bug is fixed, and stays in the suite after the fuzzer moves on.

## Call traces

Right-click a test and choose **Show Call Trace**. ForgeDefender runs that one test with `-vvvv` and shows the trace in
the **Trace** view of the ForgeDefender sidebar:

- calls nest and fold, with gas per call;
- reverted calls are red, and so is the revert they returned;
- events, contract creations and cheatcode calls are marked;
- clicking a call opens the function it ran, in your code or in a dependency.

## Coverage

Choose **Run with Coverage** (the shield-and-play icon) on any test, file or the whole project. ForgeDefender runs
`forge coverage --report lcov` and shows the result with VS Code's own coverage view: covered and uncovered lines and
branches in the editor, and percentages per file in the Test Coverage panel.

If the build fails with "stack too deep", add `--ir-minimum` to `forgeDefender.coverage.extraArgs`.

**ForgeDefender: Measure Coverage** does the same without the Testing view; the audit readiness report uses it.

## Debugging

The **Debug in terminal** profile opens forge's own debugger (`forge test --debug`) for the chosen test in a terminal.

## Settings

| Setting | Default | |
|---|---|---|
| `forgeDefender.tests.extraArgs` | `[]` | Added to every `forge test`, such as `["--ffi"]`. |
| `forgeDefender.coverage.extraArgs` | `[]` | Added to `forge coverage`, such as `["--ir-minimum"]`. |
| `forgeDefender.gas.showInline` | `true` | Gas at the end of each test's line. |
| `forgeDefender.gas.warnPercent` | `1` | Highlight a gas increase above this percentage. |
| `forgeDefender.paths.forge` | `""` | A specific `forge` binary. Empty: `forge` from the PATH. |

## With keymoat

ForgeDefender starts `forge` the same way a terminal does, by name. With [keymoat](keymoat.md) installed and first on
the PATH that VS Code sees, every test run, coverage run and trace is sandboxed: tests and their dependencies cannot
read your keys. The keymoat view in the sidebar shows whether that is the case.
