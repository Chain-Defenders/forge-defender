import * as vscode from "vscode";

// The extension calls tools by name, so with keymoat installed they go through it like in a terminal. A setting
// can point at a specific binary; it is never required.

export type ToolName = "git" | "forge" | "cast" | "anvil" | "anchor" | "solana" | "solana-test-validator" | "keymoat" | "slither" | "aderyn";

export function tool(name: ToolName): string {
  const configured = vscode.workspace.getConfiguration("forgeDefender.paths").get<string>(name);
  return configured && configured.trim() ? configured.trim() : name;
}

/** Setting `forgeDefender.<key>`. */
export function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("forgeDefender").get<T>(key, fallback);
}
