import * as http from "node:http";

// JSON-RPC to a node on this machine (Anvil, solana-test-validator). Plain HTTP on 127.0.0.1 only: these calls never
// leave the machine.

export class RpcError extends Error {}

export function rpc<T = unknown>(port: number, method: string, params: unknown[] = [], timeoutMs = 2000): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            const d = JSON.parse(text);
            if (d.error) reject(new RpcError(String(d.error.message ?? "error")));
            else resolve(d.result as T);
          } catch {
            reject(new RpcError(`not a JSON-RPC answer (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new RpcError("timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

export interface EvmStatus {
  chainId: number;
  block: number;
}

/** Chain id and block number of an EVM node on the port, or undefined when nothing answers. */
export async function evmStatus(port: number): Promise<EvmStatus | undefined> {
  try {
    const [id, block] = await Promise.all([rpc<string>(port, "eth_chainId"), rpc<string>(port, "eth_blockNumber")]);
    return { chainId: Number(BigInt(id)), block: Number(BigInt(block)) };
  } catch {
    return undefined;
  }
}

/** True when a Solana validator on the port reports itself healthy; "starting" when it answers but is not ready. */
export async function solanaHealth(port: number): Promise<"ok" | "starting" | undefined> {
  try {
    return (await rpc<string>(port, "getHealth")) === "ok" ? "ok" : "starting";
  } catch (e) {
    return e instanceof RpcError ? "starting" : undefined;
  }
}
