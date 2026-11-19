import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { parseHerdrTarget, type TerminalTarget } from "./types.ts";

const exec = promisify(execFile);
export type RunCommand = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
export const runCommand: RunCommand = async (file, args, env) => {
  try {
    const result = await exec(file, args, { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024, env });
    return result.stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
      throw new Error(error.stderr.trim());
    }
    if (error && typeof error === "object" && "killed" in error && error.killed) {
      throw new Error("Terminal command timed out after ten seconds.");
    }
    throw error;
  }
};

export function powershellPath(): string {
  return win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function detectTerminal(instanceId: string, env = process.env, platform = process.platform): TerminalTarget {
  // A Herdr pane can inherit its outer terminal or tmux environment.
  if (env.HERDR_ENV === "1") {
    return parseHerdrTarget(env.HERDR_PANE_ID, env.HERDR_SOCKET_PATH)
      ?? { kind: "unsupported", reason: "Herdr pane identity or socket is unavailable." };
  }
  if (env.TMUX && /^%\d+$/.test(env.TMUX_PANE ?? "")) {
    // TMUX = socket,pid,session; socket paths can themselves contain commas.
    return { kind: "tmux", pane: env.TMUX_PANE!, socket: env.TMUX.replace(/,\d+,\d+$/, "") };
  }
  if (env.WEZTERM_UNIX_SOCKET && /^\d+$/.test(env.WEZTERM_PANE ?? "")) {
    return { kind: "wezterm", pane: env.WEZTERM_PANE!, socket: env.WEZTERM_UNIX_SOCKET };
  }
  if (env.KITTY_LISTEN_ON && /^\d+$/.test(env.KITTY_WINDOW_ID ?? "")) {
    return { kind: "kitty", window: env.KITTY_WINDOW_ID!, socket: env.KITTY_LISTEN_ON };
  }
  // Windows Terminal's default-terminal handoff does not set WT_SESSION.
  if (platform === "win32") return { kind: "windows-terminal", marker: `[MC:${instanceId}]` };
  return { kind: "unsupported", reason: "Focus requires Herdr, Windows Terminal, tmux, WezTerm, or Kitty remote control." };
}

/** Never starts a new terminal or types into the destination's composer. */
export async function focusTerminal(target: TerminalTarget, run: RunCommand = runCommand): Promise<void> {
  switch (target.kind) {
    case "windows-terminal": {
      if (!/^\[MC:[a-f0-9-]{36}\]$/.test(target.marker)) throw new Error("Invalid terminal identity.");
      const source = await readFile(new URL("./focus-windows.ps1", import.meta.url), "utf8");
      const script = `& { ${source}\n } -Marker '${target.marker}'`;
      await run(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")]);
      return;
    }
    case "herdr":
      await run(process.env.HERDR_BIN_PATH || "herdr", ["agent", "focus", target.pane],
        { ...process.env, HERDR_SOCKET_PATH: target.socket });
      return;
    case "tmux": {
      const output = await run("tmux", ["-S", target.socket, "list-clients", "-t", target.pane, "-F", "#{client_name}"]);
      const clients = [...new Set(output.trim().split(/\r?\n/).filter(Boolean))];
      if (clients.length !== 1) throw new Error("tmux focus needs exactly one attached client for the destination session.");
      await run("tmux", ["-S", target.socket, "switch-client", "-c", clients[0], "-t", target.pane]);
      await run("tmux", ["-S", target.socket, "select-window", "-t", target.pane]);
      await run("tmux", ["-S", target.socket, "select-pane", "-t", target.pane]);
      return;
    }
    case "wezterm":
      await run("wezterm", ["cli", "--no-auto-start", "activate-pane", "--pane-id", target.pane],
        { ...process.env, WEZTERM_UNIX_SOCKET: target.socket });
      return;
    case "kitty":
      await run("kitten", ["@", "--to", target.socket, "focus-window", "--match", `id:${target.window}`]);
      return;
    case "unsupported":
      throw new Error(target.reason);
  }
}
