import * as path from "node:path";
import * as vscode from "vscode";
import type { Ctx } from "../core/context";
import { eventTopic, selector, signatureOf } from "../core/abi";
import { AbiEntry, findArtifact, listArtifacts } from "../core/artifacts";
import { exec, stripAnsi } from "../core/exec";
import { projectOf } from "../core/projects";
import { paramTypes, parseSolidity } from "../core/solidity";
import { tool } from "../core/tools";
import { argsFromCast, buildIndex, decodeWith, Match, normaliseHex, renderDecoded } from "../chain/decode";
import { matchAbiEntry, signatureFromSource } from "../chain/signatures";

// Selectors and topics on hover over function, error and event declarations, and decoding of pasted calldata or
// revert data against the project's own ABIs. Looking a selector up online happens only when the user agrees.

export function register(ctx: Ctx): void {
  ctx.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: "file", pattern: "**/*.sol" }, { provideHover: (doc, pos) => hover(ctx, doc, pos) }),
    vscode.commands.registerCommand("forgeDefender.selectors.decode", (input?: string, opts?: { show?: boolean; online?: boolean }) => decode(ctx, input, opts)),
  );
}

async function hover(ctx: Ctx, doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
  const word = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
  if (!word) return undefined;
  const text = doc.getText(word);
  const parsed = parseSolidity(doc.getText());
  for (const c of parsed.contracts) {
    let kind: "function" | "error" | "event" | undefined;
    let name = "";
    let params = "";
    const fn = c.functions.find((f) => f.line === pos.line && (text === f.name || text === "function"));
    if (fn) {
      // Internal and private functions have no selector; in an interface every function is external.
      if (c.kind !== "interface" && fn.visibility !== "public" && fn.visibility !== "external") return undefined;
      [kind, name, params] = ["function", fn.name, fn.params];
    } else {
      const d = c.declarations.find((x) => x.line === pos.line && (text === x.name || text === x.kind));
      if (!d) continue;
      [kind, name, params] = [d.kind, d.name, d.params];
    }
    const types = paramTypes(params);

    let entry: AbiEntry | undefined;
    const project = projectOf(await ctx.foundryProjects(), doc.uri.fsPath);
    if (project) {
      const rel = path.relative(project.root, doc.uri.fsPath).split(path.sep).join("/");
      const artifact = findArtifact(project.root, c.name, rel, project.config.out);
      if (artifact && artifact.source === rel) entry = matchAbiEntry(artifact.abi, kind, name, types);
    }
    const signature = entry ? signatureOf(entry) : signatureFromSource(name, types);
    if (!signature) return undefined;

    const md = new vscode.MarkdownString();
    md.appendCodeblock(signature, "solidity");
    if (kind === "event") {
      if (entry?.anonymous || /\banonymous\b/.test(lineText(doc, pos.line, params))) md.appendMarkdown("Anonymous event: no topic 0.");
      else md.appendMarkdown(`Topic 0: \`${eventTopic(signature)}\``);
    } else {
      md.appendMarkdown(`Selector: \`${selector(signature)}\``);
    }
    md.appendMarkdown(entry ? "\n\n*From the compiled ABI.*" : "\n\n*Worked out from the source; build the project to check against the compiler.*");
    return new vscode.Hover(md, word);
  }
  return undefined;
}

function lineText(doc: vscode.TextDocument, line: number, params: string): string {
  // `anonymous` comes after the parameter list, which may span lines; the declaration's own text is enough here.
  const end = Math.min(doc.lineCount - 1, line + params.split(",").length + 2);
  return doc.getText(new vscode.Range(line, 0, end, 0)).split(";")[0];
}

async function decode(ctx: Ctx, input?: string, opts: { show?: boolean; online?: boolean } = {}): Promise<string | undefined> {
  const raw =
    input ??
    (await vscode.window.showInputBox({
      prompt: "Calldata or revert data, as hex",
      placeHolder: "0x…",
      ignoreFocusOut: true,
      validateInput: (v) => (normaliseHex(v) ? undefined : "Hex, at least 4 bytes, whole bytes only"),
    }));
  if (raw === undefined) return undefined;
  const hex = normaliseHex(raw);
  if (!hex) {
    void vscode.window.showErrorMessage("That is not hex data of at least 4 bytes.");
    return undefined;
  }
  const projects = await ctx.foundryProjects();
  const index = buildIndex(projects.flatMap((p) => listArtifacts(p.root, p.config.out)));
  const sel = "0x" + hex.slice(0, 8);
  const cwd = projects[0]?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const matches: Match[] = [];
  for (const known of index.get(sel) ?? []) {
    const m = decodeWith(known, hex);
    if (!m.args) {
      // Arrays and tuples: cast decodes them, with the signature given so it never looks it up online.
      const args = known.kind === "function" ? ["decode-calldata", known.signature, "0x" + hex] : ["decode-error", "--sig", known.signature, "0x" + hex];
      const r = await exec(tool("cast"), args, { cwd, timeoutMs: 20_000 });
      if (r.code === 0) m.args = argsFromCast(known, stripAnsi(r.stdout));
    }
    matches.push(m);
  }

  const extra: string[] = [];
  if (!matches.length) {
    const ask =
      opts.online ??
      (await vscode.window.showInformationMessage(
        `${sel} is not in this project's contracts. Look it up online?`,
        { modal: true, detail: "This sends the selector to a public signature database (4byte.sourcify.dev) with `cast 4byte-calldata`." },
        "Look up online",
      )) === "Look up online";
    if (ask) {
      const r = await exec(tool("cast"), ["4byte-calldata", "0x" + hex], { cwd, timeoutMs: 30_000 });
      const out = stripAnsi(r.stdout + (r.code === 0 ? "" : r.stderr)).trim();
      extra.push("## Online lookup", "", "From 4byte.sourcify.dev, which anyone can add signatures to: a match is a guess, not proof.", "", "```", out || "No match.", "```", "");
    }
  }
  const content = renderDecoded(hex, matches, extra);
  if (opts.show !== false) {
    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: true });
  }
  ctx.log.info(`Selectors: decoded ${sel}, ${matches.length} match(es)`);
  return content;
}
