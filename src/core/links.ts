// Links back to Chain Defenders carry campaign tags, so the website can tell which part of the extension sent someone.

const site = "https://chaindefenders.xyz";

export function siteLink(path: string, campaign: string, hash = ""): string {
  const q = new URLSearchParams({ utm_source: "forgedefender", utm_medium: "vscode", utm_campaign: campaign });
  return `${site}${path}?${q.toString()}${hash ? "#" + hash : ""}`;
}

export const links = {
  auditEstimate: () => siteLink("/web3", "audit-readiness", "estimate"),
  keymoat: "https://github.com/Chain-Defenders/keymoat",
  keymoatInstall: "https://github.com/Chain-Defenders/keymoat/blob/main/docs/getting-started.md",
};
