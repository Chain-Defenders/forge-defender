// Command lines typed into a terminal. Commands that sign or deploy run in a real shell, so keymoat (when the shell
// puts it first on the PATH) can ask for confirmation there. Every argument is quoted, so a file or contract name is
// never read as shell syntax. A secret, such as an RPC URL with its API key, goes in an environment variable and is
// referenced by name, so it never appears on the command line.

export type Arg = string | { env: string };

export type ShellKind = "posix" | "powershell" | "cmd";

export function quote(arg: Arg, shell: ShellKind): string {
  if (typeof arg !== "string") {
    if (shell === "powershell") return `$env:${arg.env}`;
    if (shell === "cmd") return `%${arg.env}%`;
    return `"$${arg.env}"`;
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  if (shell === "powershell") return `'${arg.replace(/'/g, "''")}'`;
  if (shell === "cmd") return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function commandLine(args: Arg[], shell: ShellKind): string {
  const line = args.map((a) => quote(a, shell)).join(" ");
  // PowerShell needs the call operator to run a quoted program path.
  return shell === "powershell" && typeof args[0] === "string" && quote(args[0], shell) !== args[0] ? `& ${line}` : line;
}

export function shellKindOf(shellPath: string | undefined, platform: NodeJS.Platform): ShellKind {
  const s = (shellPath ?? "").toLowerCase();
  if (/pwsh|powershell/.test(s)) return "powershell";
  if (/cmd(\.exe)?$/.test(s)) return "cmd";
  if (platform === "win32" && !/bash|zsh|sh(\.exe)?$/.test(s)) return "powershell";
  return "posix";
}
