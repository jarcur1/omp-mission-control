import { posix, win32 } from "node:path";

export type SessionStatus = "working" | "idle" | "waiting";

export type TerminalTarget =
  | { kind: "windows-terminal"; marker: string }
  | { kind: "herdr"; pane: string; socket: string }
  | { kind: "herdr-core"; terminal: string }
  | { kind: "tmux"; pane: string; socket: string }
  | { kind: "wezterm"; pane: string; socket: string }
  | { kind: "kitty"; window: string; socket: string }
  | { kind: "unsupported"; reason: string };

export function parseHerdrTarget(pane: unknown, socket: unknown): Extract<TerminalTarget, { kind: "herdr" }> | null {
  if (typeof pane !== "string" || !/^w[a-z0-9]+:p[0-9]+$/.test(pane)) return null;
  // Preserve the endpoint string: Windows Herdr uses the path itself as a named pipe name.
  if (typeof socket !== "string" || /[\x00-\x1f\x7f]/.test(socket) ||
      (!posix.isAbsolute(socket) && !win32.isAbsolute(socket))) return null;
  return { kind: "herdr", pane, socket };
}

/** herdr-core address from `$HC_TERMINAL_ID`: `t7`, `t1g`, or `machine/t7`. */
export function parseHerdrCoreTarget(terminal: unknown): Extract<TerminalTarget, { kind: "herdr-core" }> | null {
  if (typeof terminal !== "string") return null;
  if (!/^(?:[a-z0-9][a-z0-9._-]{0,31}\/)?t[a-z0-9]{1,32}$/.test(terminal)) return null;
  return { kind: "herdr-core", terminal };
}

/** One live top-level interactive terminal, not a saved conversation or subagent. */
export interface LiveSession {
  version: 1;
  instanceId: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  project: string;
  cwd: string;
  model: string;
  task: string;
  status: SessionStatus;
  detail: string;
  startedAt: number;
  updatedAt: number;
  terminal: TerminalTarget;
}

export interface DashboardAction {
  kind: "focus" | "trace";
  instanceId: string;
}

/** Strip terminal control sequences before persisting or rendering outside content. */
export function cleanText(value: string, max = 240): string {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}
