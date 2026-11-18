import * as net from "node:net";
import * as http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { waitFor } from "./helpers";

// Shared by the Chain suites: a free port and an Anvil started directly (not through the extension).

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export function rpc(port: number, method: string, params: unknown[] = []): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { "content-type": "application/json" }, timeout: 2000 }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(t).result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

export async function startAnvil(port: number): Promise<ChildProcess> {
  const child = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  await waitFor(() => rpc(port, "eth_chainId").then((r) => r as string, () => undefined), "anvil to start", 30_000);
  return child;
}

export async function stopAnvil(child: ChildProcess, port: number): Promise<void> {
  child.kill();
  await waitFor(() => rpc(port, "eth_chainId").then(() => undefined, () => true), "anvil to stop", 15_000);
}
