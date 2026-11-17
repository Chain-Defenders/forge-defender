import { spawn } from "node:child_process";

// Every tool the extension uses runs through here: no shell, so a file name can never become a command, and a
// cancelled run kills the whole process group (forge starts solc, anchor starts a validator).

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Called with each line of stdout and stderr as it arrives. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The program could not be started at all (usually: not installed). */
  notFound?: boolean;
  cancelled?: boolean;
}

export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancelled = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = () => {
      cancelled = true;
      if (child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill();
      } catch {
        child.kill();
      }
    };
    opts.signal?.addEventListener("abort", kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;

    const lines = (stream: "stdout" | "stderr") => {
      let rest = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (stream === "stdout") stdout += text;
        else stderr += text;
        if (!opts.onLine) return;
        const parts = (rest + text).split(/\r?\n/);
        rest = parts.pop() ?? "";
        for (const p of parts) opts.onLine(p, stream);
      };
    };
    child.stdout.on("data", lines("stdout"));
    child.stderr.on("data", lines("stderr"));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve(r);
    };
    child.on("error", (err: NodeJS.ErrnoException) =>
      done({ code: null, stdout, stderr: stderr + err.message, notFound: err.code === "ENOENT", cancelled }),
    );
    child.on("close", (code) => done({ code, stdout, stderr, cancelled }));
  });
}

/** Removes terminal colours, which some tools print even into a pipe. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
