import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

// Starts a real VS Code with the extension and a copy of the fixture workspace, and runs suite/*.test.js inside it.

async function main() {
  const root = path.resolve(__dirname, "../../..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forgedefender-ws-"));
  fs.cpSync(path.join(root, "test/fixtures"), work, { recursive: true });
  // A short user-data folder: the editor's socket path must stay under 104 characters on macOS.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "fd-ud-"));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite/index.js"),
      launchArgs: [work, "--disable-extensions", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`],
      version: process.env.VSCODE_TEST_VERSION ?? "stable",
      extensionTestsEnv: { FORGEDEFENDER_TEST_WORKSPACE: work },
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
