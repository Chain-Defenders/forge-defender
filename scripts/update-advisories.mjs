// Regenerates src/security/data/advisories.json from the GitHub Advisory Database, through the `gh` CLI (it must be
// signed in). Run it before a release: `node scripts/update-advisories.mjs`. The file records when it was made, so
// the extension can say how old its data is.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const packages = [
  { ecosystem: "npm", name: "@openzeppelin/contracts" },
  { ecosystem: "npm", name: "@openzeppelin/contracts-upgradeable" },
  { ecosystem: "npm", name: "solady" },
  { ecosystem: "npm", name: "solmate" },
  { ecosystem: "rust", name: "anchor-lang" },
  { ecosystem: "rust", name: "anchor-spl" },
  { ecosystem: "rust", name: "solana-program" },
  { ecosystem: "rust", name: "spl-token" },
  { ecosystem: "rust", name: "spl-token-2022" },
];

function fetchAdvisories(ecosystem, name) {
  const out = execFileSync(
    "gh",
    ["api", "-X", "GET", "/advisories", "-f", `ecosystem=${ecosystem}`, "-f", `affects=${name}`, "-f", "per_page=100", "--paginate"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // --paginate prints one JSON array per page, back to back.
  return JSON.parse(`[${out.trim().replace(/\]\s*\[/g, "],[")}]`).flat();
}

const byId = new Map();
for (const p of packages) {
  const list = fetchAdvisories(p.ecosystem, p.name);
  process.stderr.write(`${p.ecosystem} ${p.name}: ${list.length}\n`);
  for (const a of list) {
    if (a.withdrawn_at) continue;
    const ranges = (a.vulnerabilities ?? [])
      .filter((v) => v.package?.ecosystem === p.ecosystem && v.package?.name === p.name && v.vulnerable_version_range)
      .map((v) => ({ range: v.vulnerable_version_range, fixed: v.first_patched_version ?? null }));
    if (!ranges.length) continue;
    const entry = byId.get(a.ghsa_id) ?? {
      id: a.ghsa_id,
      cve: a.cve_id ?? null,
      title: a.summary,
      severity: a.severity,
      url: a.html_url,
      published: a.published_at?.slice(0, 10) ?? null,
      affected: [],
    };
    for (const r of ranges) entry.affected.push({ ecosystem: p.ecosystem, package: p.name, ...r });
    byId.set(a.ghsa_id, entry);
  }
}

const advisories = [...byId.values()].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? "") || a.id.localeCompare(b.id));
const data = {
  source: "GitHub Advisory Database (gh api /advisories)",
  generated: new Date().toISOString().slice(0, 10),
  packages: packages.map((p) => `${p.ecosystem}:${p.name}`),
  advisories,
};
writeFileSync(new URL("../src/security/data/advisories.json", import.meta.url), JSON.stringify(data, null, 2) + "\n");
process.stderr.write(`${advisories.length} advisories written\n`);
