import * as fs from "node:fs";
import * as path from "node:path";
import { checksumAddress } from "../core/abi";

// Deployments recorded by `forge script --broadcast`: <broadcast>/<Script>.s.sol/<chainId>/run-latest.json.
// Dry runs go to a dry-run/ folder next to it and are not deployments, so they are skipped.

export interface Deployment {
  contractName: string;
  address: string;
  txHash: string;
  chainId: number;
  /** Script file name, such as Deploy.s.sol. */
  script: string;
  /** Milliseconds since 1970, from the run's timestamp. */
  time: number;
  kind: "CREATE" | "CREATE2" | "additional";
}

interface BroadcastTx {
  hash?: string | null;
  transactionType?: string;
  contractName?: string | null;
  contractAddress?: string | null;
  additionalContracts?: { transactionType?: string; contractName?: string | null; address?: string }[];
}

interface BroadcastFile {
  transactions?: BroadcastTx[];
  receipts?: { transactionHash?: string; status?: string }[];
  timestamp?: number;
  chain?: number;
}

/** Contracts a run created. Transactions whose receipt shows a failure are left out. */
export function parseBroadcast(json: string, script: string, chainIdFromPath: number): Deployment[] {
  const d = JSON.parse(json) as BroadcastFile;
  const chainId = typeof d.chain === "number" ? d.chain : chainIdFromPath;
  // Older forge wrote seconds, newer writes milliseconds.
  const ts = typeof d.timestamp === "number" ? (d.timestamp < 1e12 ? d.timestamp * 1000 : d.timestamp) : 0;
  const failed = new Set((d.receipts ?? []).filter((r) => r.status === "0x0").map((r) => r.transactionHash));
  const out: Deployment[] = [];
  for (const t of d.transactions ?? []) {
    if (!t.hash || failed.has(t.hash)) continue;
    if ((t.transactionType === "CREATE" || t.transactionType === "CREATE2") && t.contractAddress) {
      out.push({
        contractName: t.contractName || "(unknown contract)",
        address: checksumAddress(t.contractAddress),
        txHash: t.hash,
        chainId,
        script,
        time: ts,
        kind: t.transactionType,
      });
    }
    for (const a of t.additionalContracts ?? []) {
      if (!a.address) continue;
      out.push({
        contractName: a.contractName || "(unknown contract)",
        address: checksumAddress(a.address),
        txHash: t.hash,
        chainId,
        script,
        time: ts,
        kind: "additional",
      });
    }
  }
  return out;
}

/** Every deployment under a project's broadcast folder, newest first. */
export function readDeployments(broadcastDir: string, onError?: (file: string, e: unknown) => void): Deployment[] {
  const out: Deployment[] = [];
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const script of dirs(broadcastDir)) {
    for (const chain of dirs(path.join(broadcastDir, script))) {
      if (!/^\d+$/.test(chain)) continue;
      const file = path.join(broadcastDir, script, chain, "run-latest.json");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        out.push(...parseBroadcast(text, script, Number(chain)));
      } catch (e) {
        onError?.(file, e);
      }
    }
  }
  return out.sort((a, b) => b.time - a.time || a.contractName.localeCompare(b.contractName));
}
