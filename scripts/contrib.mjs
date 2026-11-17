// Each feature declares its commands, views, menus and settings in contrib/<feature>.json. This merges them into
// package.json's "contributes", so features do not edit one shared block. `--check` fails when package.json is stale.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const pkgPath = new URL("../package.json", import.meta.url);
const dir = new URL("../contrib/", import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const merged = {};
const seen = new Map();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const part = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
  for (const [key, value] of Object.entries(part)) {
    if (Array.isArray(value)) {
      merged[key] = [...(merged[key] ?? []), ...value];
    } else if (key === "configuration") {
      merged[key] ??= { title: "ForgeDefender", properties: {} };
      Object.assign(merged[key].properties, value.properties);
    } else {
      // Objects of arrays: views, menus, viewsContainers.
      merged[key] ??= {};
      for (const [sub, list] of Object.entries(value)) {
        if (Array.isArray(list)) {
          merged[key][sub] = [...(merged[key][sub] ?? []), ...list];
        } else {
          merged[key][sub] = list;
        }
      }
    }
  }
  for (const c of part.commands ?? []) {
    if (seen.has(c.command)) throw new Error(`${c.command} is declared in ${seen.get(c.command)} and ${file}`);
    seen.set(c.command, file);
  }
}

const next = JSON.stringify({ ...pkg, contributes: merged }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (next !== readFileSync(pkgPath, "utf8")) {
    console.error("package.json is out of date with contrib/: run `npm run contrib`");
    process.exit(1);
  }
} else {
  writeFileSync(pkgPath, next);
}
