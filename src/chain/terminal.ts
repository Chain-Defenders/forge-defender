import * as vscode from "vscode";
import { Arg, commandLine, shellKindOf } from "./shell";

// Runs a command in a new, visible terminal. Used for everything that signs, broadcasts or deploys, and for
// long-running nodes. A new terminal each time, because environment variables are fixed when a terminal starts.

export interface TerminalRun {
  name: string;
  cwd: string;
  args: Arg[];
  /** Variables the command line refers to with { env: NAME }; kept off the command line itself. */
  env?: Record<string, string>;
  /** False: type the command without pressing Enter, for the person to check first. */
  send?: boolean;
}

export function runInTerminal(run: TerminalRun): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: run.name,
    cwd: run.cwd,
    env: run.env,
    iconPath: new vscode.ThemeIcon("shield"),
  });
  terminal.show();
  terminal.sendText(commandLine(run.args, shellKindOf(vscode.env.shell, process.platform)), run.send ?? true);
  return terminal;
}
