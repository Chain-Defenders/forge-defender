import * as vscode from "vscode";

// Between the Anchor test runner and the Solana tools view, which reads the program logs a run leaves behind.

export interface AnchorRunEvent {
  root: string;
  ok: boolean;
}

export const anchorRuns = new vscode.EventEmitter<AnchorRunEvent>();
