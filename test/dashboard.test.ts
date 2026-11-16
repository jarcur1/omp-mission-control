import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { MissionControlDashboard } from "../src/dashboard.ts";
import type { DashboardAction, LiveSession } from "../src/types.ts";

function makeSession(overrides: Partial<LiveSession> & { instanceId: string }): LiveSession {
  return {
    version: 1,
    pid: 1000,
    sessionId: `sess-${overrides.instanceId}`,
    sessionFile: `/tmp/${overrides.instanceId}.jsonl`,
    project: `project-${overrides.instanceId}`,
    cwd: `/work/${overrides.instanceId}`,
    model: "claude-sonnet-4-5",
    task: `task for ${overrides.instanceId}`,
    status: "working",
    detail: "running tool",
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    terminal: { kind: "windows-terminal", marker: `WT-${overrides.instanceId}` },
    ...overrides,
  };
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("MissionControlDashboard", () => {
  it("does not accidentally dispatch focus or trace when the selected session is removed", () => {
    const actions: DashboardAction[] = [];
    const sessions = [
      makeSession({ instanceId: "a" }),
      makeSession({ instanceId: "b" }),
      makeSession({ instanceId: "c" }),
    ];

    const dashboard = new MissionControlDashboard({
      currentInstanceId: "a",
      sessions,
      onAction: (action) => actions.push(action),
      onClose: () => {},
      requestRender: () => {},
      getHeight: () => 20,
    });

    // Move selection to "b".
    dashboard.handleInput("\x1b[B");
    // Refresh removes "b" while "a" and "c" remain.
    dashboard.update([sessions[0], sessions[2]]);

    // Pressing Enter or t immediately after removal must NOT target "a" or "c".
    dashboard.handleInput("\r");
    dashboard.handleInput("t");
    expect(actions).toEqual([]);

    const rendered = dashboard.render(100).map(stripSgr).join("\n");
    expect(rendered).toContain("No active selection");

    // Explicit navigation recovers selection onto the remaining list.
    dashboard.handleInput("j");
    dashboard.handleInput("\r");
    expect(actions).toEqual([{ kind: "focus", instanceId: "c" }]);
  });

  it("tracks selection by instanceId across reordering and dispatches the exact selected target", () => {
    const actions: DashboardAction[] = [];
    const s1 = makeSession({ instanceId: "inst-1", project: "alpha" });
    const s2 = makeSession({ instanceId: "inst-2", project: "beta" });
    const s3 = makeSession({ instanceId: "inst-3", project: "gamma" });

    const dashboard = new MissionControlDashboard({
      currentInstanceId: "inst-1",
      sessions: [s1, s2, s3],
      onAction: (action) => actions.push(action),
      onClose: () => {},
      requestRender: () => {},
      getHeight: () => 24,
    });

    // Move to inst-2, then reorder list and remove inst-1.
    dashboard.handleInput("j");
    dashboard.update([s3, s2]);

    dashboard.handleInput("t");
    dashboard.handleInput("\r");
    expect(actions).toEqual([
      { kind: "trace", instanceId: "inst-2" },
      { kind: "focus", instanceId: "inst-2" },
    ]);

    // Filter out inst-2; actions must not fire for a hidden/non-visible item.
    actions.length = 0;
    dashboard.handleInput("/");
    dashboard.handleInput("g");
    dashboard.handleInput("a");
    dashboard.handleInput("m");
    dashboard.handleInput("\r"); // apply filter
    dashboard.handleInput("\r"); // attempt focus while inst-2 is filtered out
    dashboard.handleInput("t");
    expect(actions).toEqual([]);
  });

  it("bounds width and height with wide Unicode, emoji, and untrusted terminal escapes", () => {
    const sessions: LiveSession[] = [
      makeSession({
        instanceId: "unicode-1",
        project: "🚀プロジェクト名とても長い名前\x1b]0;pwned\x07\u202e",
        model: "claude-opus-4-6-extended-日本語テスト",
        task: "修正する: ワイド文字と結合文字 e\u0301 👨‍👩‍👧‍👦 と ANSI \x1b[31mred\x1b[0m",
        cwd: "C:\\Users\\ユーザー\\開発\\プロジェクト\\長いパス\\Mission_Control",
        detail: "待機中\tタブ\n改行\x07ベル",
        status: "waiting",
        sessionFile: undefined,
        terminal: { kind: "unsupported", reason: "headless \x1b[2J SSH" },
      }),
      makeSession({
        instanceId: "unicode-2",
        project: "second-session",
        status: "idle",
        terminal: { kind: "tmux", pane: "%4", socket: "/tmp/tmux-1000/default" },
      }),
    ];

    let height = 18;
    const dashboard = new MissionControlDashboard({
      currentInstanceId: "unicode-1",
      sessions,
      onAction: () => {},
      onClose: () => {},
      requestRender: () => {},
      getHeight: () => height,
    });

    for (const [width, h] of [
      [75, 18],
      [120, 24],
      [40, 7],
      [75, 4],
      [5, 4],
      [12, 5],
      [1, 1],
      [4, 3],
    ] as const) {
      height = h;
      const lines = dashboard.render(width);
      expect(lines.length).toBeLessThanOrEqual(h);
      if (width >= 5 && h >= 4) {
        const plainLines = lines.map(stripSgr);
        expect(plainLines[0]).toBe(`╭${"─".repeat(width - 2)}╮`);
        expect(plainLines.at(-1)).toBe(`╰${"─".repeat(width - 2)}╯`);
        for (const line of plainLines.slice(1, -1)) {
          expect(line.startsWith("│ ")).toBe(true);
          expect(line.endsWith(" │")).toBe(true);
        }
        // Short rows must cover the full panel, not expose transcript text underneath.
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toContain("\x1b]");
        expect(line).not.toContain("\x1b[2J");
        expect(line).not.toContain("\u202e");
        expect(line).not.toContain("\x07");
      }
    }

    // At compact ~75 cols and height 18, key status/availability info remains visible.
    height = 18;
    const compactText = dashboard.render(75).map(stripSgr).join("\n");
    expect(compactText).toContain("Mission Control");
    expect(compactText).toContain("waiting");
    expect(compactText).toContain("[current");
    expect(compactText).toContain("unsupported");
    expect(compactText).toContain("no session file");
  });
});
