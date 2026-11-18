// The mocha reporter passed to `anchor test`. It prints a spec-like summary for people and one marked JSON line
// per event for the editor, so results arrive while the run is going. It only uses runner events that every mocha
// version since 4 emits, because each project brings its own mocha.

export const markerPrefix = "@@forgedefender ";

export const reporterSource = String.raw`"use strict";
const prefix = ${JSON.stringify(markerPrefix)};
const show = (v) => {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};
module.exports = function ForgeDefenderReporter(runner) {
  const out = (s) => process.stdout.write(s + "\n");
  const mark = (o) => out(prefix + JSON.stringify(o));
  const titlePath = (r) => (typeof r.titlePath === "function" ? r.titlePath() : [r.title]);
  const failures = [];
  let depth = 0;
  let passes = 0, pending = 0;
  runner.on("suite", (s) => {
    if (s.title) out("  ".repeat(depth + 1) + s.title);
    if (s.title) depth++;
  });
  runner.on("suite end", (s) => { if (s.title) depth--; });
  runner.on("test", (t) => mark({ event: "start", path: titlePath(t), file: t.file }));
  runner.on("pass", (t) => {
    passes++;
    out("  ".repeat(depth + 1) + "ok " + t.title + (t.duration !== undefined ? " (" + t.duration + "ms)" : ""));
    mark({ event: "pass", path: titlePath(t), file: t.file, duration: t.duration });
  });
  runner.on("pending", (t) => {
    pending++;
    out("  ".repeat(depth + 1) + "- " + t.title);
    mark({ event: "pending", path: titlePath(t), file: t.file });
  });
  runner.on("fail", (t, err) => {
    err = err || {};
    failures.push([t, err]);
    const hook = t.type === "hook";
    out("  ".repeat(depth + 1) + failures.length + ") " + t.title);
    mark({
      event: "fail",
      hook,
      path: hook && t.parent ? titlePath(t.parent) : titlePath(t),
      title: t.title,
      file: t.file || (t.parent && t.parent.file),
      duration: t.duration,
      message: String(err.message !== undefined ? err.message : err),
      stack: err.stack,
      expected: err.showDiff !== false ? show(err.expected) : undefined,
      actual: err.showDiff !== false ? show(err.actual) : undefined,
    });
  });
  runner.once("end", () => {
    out("");
    out("  " + passes + " passing");
    if (pending) out("  " + pending + " pending");
    if (failures.length) out("  " + failures.length + " failing");
    failures.forEach(([t, err], i) => {
      out("");
      out("  " + (i + 1) + ") " + titlePath(t).join(" "));
      out(String(err.stack || err.message || err).split("\n").map((l) => "      " + l).join("\n"));
    });
    mark({ event: "end" });
  });
};
`;
