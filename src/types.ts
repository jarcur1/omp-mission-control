export type SessionStatus = "working" | "idle" | "waiting";

export type TerminalTarget =
  | { kind: "windows-terminal"; marker: string }
  | { kind: "tmux"; pane: string; socket: string }
  | { kind: "wezterm"; pane: string; socket: string }
  | { kind: "kitty"; window: string; socket: string }
  | { kind: "unsupported"; reason: string };

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
