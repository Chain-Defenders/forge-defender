import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";

// Small editor helpers shared by the security features.

export const OPEN_LOCATION = "forgeDefender.security.openLocation";

/** A command link for webviews that opens `file` (relative to `root`) at a 1-based line. */
export function openLink(root: string, file: string, line: number): string {
  return `command:${OPEN_LOCATION}?${encodeURIComponent(JSON.stringify([root, file, line]))}`;
}

export function commandLink(command: string, args: unknown[] = []): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

let registered: vscode.Disposable | undefined;

/** Registered by whichever security feature starts first. */
export function registerOpenLocation(ctx: Ctx) {
  if (registered) return;
  ctx.subscriptions.push(
    { dispose: () => (registered = undefined) },
    (registered =
    vscode.commands.registerCommand(OPEN_LOCATION, async (root: string, file: string, line: number) => {
      const uri = vscode.Uri.file(path.isAbsolute(file) ? file : path.join(root, file));
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One });
    })),
  );
}

const panels = new Map<string, vscode.WebviewPanel>();

/** Shows HTML in a webview, reusing the panel with the same key. `html` gets the panel's CSP source. */
export function showHtml(key: string, title: string, html: (cspSource: string) => string): vscode.WebviewPanel {
  let panel = panels.get(key);
  if (!panel) {
    panel = vscode.window.createWebviewPanel(`forgeDefender.security.${key.split(":")[0]}`, title, vscode.ViewColumn.Beside, {
      enableCommandUris: true,
      enableScripts: false,
      retainContextWhenHidden: false,
    });
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
  }
  panel.title = title;
  panel.webview.html = html(panel.webview.cspSource);
  panel.reveal(undefined, true);
  return panel;
}

/** Re-renders a panel that is already open, without bringing it forward. */
export function updateHtml(key: string, html: (cspSource: string) => string): boolean {
  const panel = panels.get(key);
  if (panel) panel.webview.html = html(panel.webview.cspSource);
  return Boolean(panel);
}

export function relPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function lastLines(text: string, n = 6): string {
  return text.trim().split("\n").slice(-n).join("\n");
}
