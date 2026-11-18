import * as path from "node:path";

// Static analysis engines: how to call each one and how to read its JSON. Adding an engine means adding an entry
// here (and its tool name in core/tools.ts); the editor side in analysis.ts does not change.

export type FindingSeverity = "high" | "medium" | "low" | "info" | "optimization";

export interface Finding {
  engine: string;
  detector: string;
  title: string;
  severity: FindingSeverity;
  confidence?: string;
  /** Path relative to the project root. */
  file: string;
  /** 1-based. */
  line: number;
  endLine?: number;
  /** Other places the finding mentions, as "file:line". */
  related: { file: string; line: number }[];
  docs?: string;
}

export interface Engine {
  id: string;
  /** Shown as the diagnostics' source. */
  label: string;
  /** The tool name in forgeDefender.paths. */
  tool: "slither" | "aderyn";
  /** Arguments for a run in the project root. `outFile` is a temporary path the engine may write its JSON to. */
  args(outFile: string): string[];
  /** Where the JSON is: "stdout" or the out file. */
  output: "stdout" | "file";
  /** Throws when the output says the run failed. */
  parse(json: string): Finding[];
  /** A link to the detector's documentation. */
  docs(detector: string, severity: FindingSeverity): string | undefined;
}

/** Dependencies are someone else's code: their findings are not the developer's to fix here. */
export function inDependency(file: string): boolean {
  return /(^|[\\/])(lib|node_modules|dependencies)[\\/]/.test(file);
}

const jsonFrom = (text: string) => {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON in the output");
  return JSON.parse(text.slice(start));
};

const slitherSeverity: Record<string, FindingSeverity> = { High: "high", Medium: "medium", Low: "low", Informational: "info", Optimization: "optimization" };

/** Slither's wiki anchors come from its own detector list; filled in by the editor side when available. */
export const slitherWiki = new Map<string, string>();

export const slither: Engine = {
  id: "slither",
  label: "Slither",
  tool: "slither",
  args: () => [".", "--json", "-"],
  output: "stdout",
  parse(text) {
    const d = jsonFrom(text);
    if (!d.success) throw new Error(String(d.error ?? "Slither failed"));
    const out: Finding[] = [];
    for (const r of d.results?.detectors ?? []) {
      const places: { file: string; line: number; endLine?: number }[] = [];
      for (const e of r.elements ?? []) {
        const sm = e.source_mapping;
        const file = sm?.filename_relative;
        if (!file || !sm.lines?.length) continue;
        if (e.source_mapping.is_dependency || inDependency(file)) continue;
        places.push({ file, line: sm.lines[0], endLine: e.type === "function" || e.type === "contract" ? undefined : sm.lines[sm.lines.length - 1] });
      }
      if (!places.length) continue;
      // The first markdown element is where Slither itself points; use it when it is in the project.
      const md = String(r.first_markdown_element ?? "").match(/^(.+)#L(\d+)(?:-L(\d+))?$/);
      const main = md && !inDependency(md[1]) ? { file: md[1], line: Number(md[2]), endLine: md[3] ? Number(md[3]) : undefined } : places[0];
      const severity = slitherSeverity[r.impact] ?? "info";
      out.push({
        engine: "slither",
        detector: r.check,
        title: String(r.description ?? r.check).split("\n")[0].trim(),
        severity,
        confidence: r.confidence,
        file: main.file,
        line: main.line,
        endLine: main.endLine,
        related: places.filter((p) => p.file !== main.file || p.line !== main.line).map((p) => ({ file: p.file, line: p.line })),
        docs: slither.docs(r.check, severity),
      });
    }
    return out;
  },
  docs: (detector) => slitherWiki.get(detector) ?? "https://github.com/crytic/slither/wiki/Detector-Documentation",
};

export const aderyn: Engine = {
  id: "aderyn",
  label: "Aderyn",
  tool: "aderyn",
  args: (outFile) => [".", "--output", outFile],
  output: "file",
  parse(text) {
    const d = jsonFrom(text);
    const out: Finding[] = [];
    for (const [key, severity] of [
      ["high_issues", "high"],
      ["low_issues", "low"],
    ] as const) {
      for (const issue of d[key]?.issues ?? []) {
        const places = (issue.instances ?? [])
          .filter((i: any) => i.contract_path && !inDependency(i.contract_path))
          .map((i: any) => ({ file: path.normalize(i.contract_path), line: Number(i.line_no) || 1 }));
        // One diagnostic per instance: Aderyn groups every place a detector fires under one issue.
        for (const p of places) {
          out.push({
            engine: "aderyn",
            detector: issue.detector_name,
            title: issue.title,
            severity,
            file: p.file,
            line: p.line,
            related: [],
            docs: aderyn.docs(issue.detector_name, severity),
          });
        }
      }
    }
    return out;
  },
  // Aderyn has no per-detector pages; its detectors' sources are grouped by severity.
  docs: (_detector, severity) => `https://github.com/Cyfrin/aderyn/tree/dev/aderyn_core/src/detect/${severity === "high" ? "high" : "low"}`,
};

export const engines: Engine[] = [slither, aderyn];

export function engineById(id: string): Engine | undefined {
  return engines.find((e) => e.id === id);
}
