import type { ReadinessReport, Place } from "./report";
import { coverageLine, coveragePercent } from "./report";
import { layoutRows, structRows, type StorageLayout } from "./layout";

// HTML for the security webviews. Colours come only from the editor's theme variables, so the pages follow light,
// dark and high-contrast themes without a palette of their own.

export const esc = (s: string | number) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const style = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 8px 24px 32px; line-height: 1.5; max-width: 980px; }
h1 { font-size: 1.5em; font-weight: 600; margin: 16px 0 4px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); }
.muted { color: var(--vscode-descriptionForeground); }
table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; }
th, td { text-align: left; padding: 4px 10px 4px 0; vertical-align: top; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
th { font-weight: 600; color: var(--vscode-descriptionForeground); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code, .mono { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 12px 0; }
.card { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, transparent)); background: var(--vscode-editorWidget-background); border-radius: 4px; padding: 10px 12px; }
.card .v { font-size: 1.5em; font-weight: 600; font-variant-numeric: tabular-nums; }
.card .k { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.bad { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
a { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
.cta { margin-top: 32px; padding: 14px 16px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); }
details summary { cursor: pointer; }
ul { padding-left: 20px; margin: 4px 0; }
`;

export function page(title: string, body: string, cspSource: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${style}</style></head>
<body>${body}</body></html>`;
}

export interface Linker {
  /** A link that opens a file at a line in the editor. */
  open(file: string, line: number): string;
}

function places(list: Place[], link: Linker, empty: string, limit = 50): string {
  if (!list.length) return `<p class="ok">${esc(empty)}</p>`;
  const items = list
    .slice(0, limit)
    .map((p) => `<li><a href="${esc(link.open(p.file, p.line))}"><code>${esc(p.file)}:${p.line}</code></a> ${esc(p.text)}</li>`)
    .join("");
  const more = list.length > limit ? `<li class="muted">and ${list.length - limit} more</li>` : "";
  return `<ul>${items}${more}</ul>`;
}

function fileTable(rows: { file: string; nsloc: number }[], link: Linker, total?: number): string {
  const body = rows.map((r) => `<tr><td><a href="${esc(link.open(r.file, 1))}"><code>${esc(r.file)}</code></a></td><td class="num">${r.nsloc}</td></tr>`).join("");
  const foot = total === undefined ? "" : `<tr><th>Total</th><th class="num">${total}</th></tr>`;
  return `<table><thead><tr><th>File</th><th class="num">nSLOC</th></tr></thead><tbody>${body}${foot}</tbody></table>`;
}

export function readinessHtml(r: ReadinessReport, link: Linker, actions: { writeScope: string; runCoverage?: string }, cspSource: string): string {
  const c = r.coverage;
  const card = (v: string | number, k: string, cls = "") => `<div class="card"><div class="v ${cls}">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
  const tests = r.tests;
  const cards = [
    card(r.nsloc, "nSLOC in scope"),
    card(r.scope.length, r.scope.length === 1 ? "file in scope" : "files in scope"),
    card(c ? coveragePercent(c.lines) : "none", "line coverage"),
    card(c ? coveragePercent(c.branches) : "none", "branch coverage"),
    card(r.missingNatspec.length, "functions without NatSpec", r.missingNatspec.length ? "" : "ok"),
    card(r.floatingPragmas.length, "floating pragmas", r.floatingPragmas.length ? "" : "ok"),
    card(r.todos.length, "TODO / FIXME", r.todos.length ? "" : "ok"),
    card(tests ? `${tests.passed} / ${tests.failed}` : "none", "tests passed / failed", tests ? (tests.failed ? "bad" : "ok") : ""),
  ].join("");

  const coverage = c
    ? `<p>${esc(coverageLine(c))}</p>`
    : `<p class="muted">No coverage yet.${actions.runCoverage ? ` <a href="${esc(actions.runCoverage)}">Run coverage</a>` : " Run <code>forge coverage --report lcov</code> in the project, then refresh."}</p>`;
  const unexecuted = c ? places(r.unexecuted, link, "Every in-scope function ran at least once.") : `<p class="muted">Needs coverage.</p>`;
  const testLine = tests
    ? `<p>${tests.passed} passed, <span class="${tests.failed ? "bad" : ""}">${tests.failed} failed</span>, ${tests.skipped} skipped <span class="muted">(${esc(tests.at)})</span></p>`
    : `<p class="muted">No test run since the editor started.</p>`;

  const grant = r.grant
    ? `<p>At ${r.nsloc} nSLOC this project fits the Chain Defenders audit grant (Cohort 1, up to ${r.grant.maxNsloc.toLocaleString("en-GB")} nSLOC, closes ${esc(r.grant.closes)}). <a href="${esc(r.grant.url)}">See the grant</a></p>`
    : "";

  const body = `
<h1>Audit readiness</h1>
<p class="muted">${esc(r.project)} · <a href="${esc(actions.writeScope)}">Write scope.txt</a></p>
<div class="cards">${cards}</div>
<h2>In scope</h2>
${r.scope.length ? fileTable(r.scope, link, r.nsloc) : `<p class="muted">No Solidity files in the source folder.</p>`}
${r.interfaces.length ? `<h2>Interfaces</h2><p class="muted">Not counted in scope.</p>${fileTable(r.interfaces, link)}` : ""}
${r.mocks.length ? `<h2>Mocks</h2><p class="muted">Not counted in scope.</p>${fileTable(r.mocks, link)}` : ""}
<h2>Coverage</h2>
${coverage}
<h2>Functions never run by the tests</h2>
${unexecuted}
<h2>Public and external functions without NatSpec</h2>
${places(r.missingNatspec, link, "Every public and external function is documented.")}
<h2>Floating pragmas</h2>
${places(r.floatingPragmas, link, "Every pragma names one compiler version.")}
<h2>TODO and FIXME</h2>
${places(r.todos, link, "None left.")}
<h2>Last test run</h2>
${testLine}
<div class="cta">When you are ready, <a href="${esc(r.estimateUrl)}">get an audit estimate from Chain Defenders</a>.${grant}</div>
`;
  return page("Audit readiness", body, cspSource);
}

export function layoutHtml(contract: string, l: StorageLayout, baseline: string | undefined, cspSource: string): string {
  const rows = layoutRows(l)
    .map((r) => `<tr><td class="num">${esc(r.slot)}</td><td class="num">${r.offset}</td><td class="num">${r.bytes}</td><td><code>${esc(r.label)}</code></td><td><code>${esc(r.type)}</code></td></tr>`)
    .join("");
  const structs = structRows(l)
    .map(
      (s) =>
        `<h2><code>${esc(s.struct)}</code></h2><table><thead><tr><th class="num">Slot</th><th class="num">Offset</th><th>Member</th><th>Type</th></tr></thead><tbody>${s.members
          .map((m) => `<tr><td class="num">${esc(m.slot)}</td><td class="num">${m.offset}</td><td><code>${esc(m.label)}</code></td><td><code>${esc(m.type)}</code></td></tr>`)
          .join("")}</tbody></table>`,
    )
    .join("");
  const body = `<h1>Storage layout</h1>
<p class="muted"><code>${esc(contract)}</code> · ${baseline ? `baseline saved ${esc(baseline)}` : "no baseline saved"}</p>
${l.storage.length ? `<table><thead><tr><th class="num">Slot</th><th class="num">Offset</th><th class="num">Bytes</th><th>Name</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">This contract has no storage variables.</p>`}
${structs ? `<p class="muted">Slots in structs are relative to where the struct starts.</p>${structs}` : ""}`;
  return page("Storage layout", body, cspSource);
}
