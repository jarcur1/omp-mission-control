import { expect, test } from "bun:test";
import { detectTerminal, focusTerminal } from "../src/focus.ts";

const instanceId = "11111111-1111-4111-8111-111111111111";
const tmux = { TMUX: "/tmp/tmux/default,321,0", TMUX_PANE: "%1" };

test("Herdr panes take precedence over inherited outer terminal identity", () => {
  const socket = "C:/Users/test/AppData/Roaming/herdr/sessions/work\\herdr.sock";
  const env = { ...tmux, HERDR_ENV: "1", HERDR_PANE_ID: "w2:p3", HERDR_SOCKET_PATH: socket };
  expect(detectTerminal(instanceId, env, "win32")).toEqual({ kind: "herdr", pane: "w2:p3", socket });
  expect(detectTerminal(instanceId, { ...env, HERDR_SOCKET_PATH: undefined }, "win32").kind).toBe("unsupported");
  expect(detectTerminal(instanceId, { ...env, HERDR_ENV: undefined }, "linux")).toEqual({ kind: "tmux", pane: "%1", socket: "/tmp/tmux/default" });
  expect(detectTerminal(instanceId, {}, "win32")).toEqual({ kind: "windows-terminal", marker: `[MC:${instanceId}]` });
});

test("Herdr focus routes matching pane IDs to their own servers", async () => {
  const calls: unknown[] = [];
  for (const socket of ["/tmp/herdr/first server.sock", "/tmp/herdr/second server.sock"]) {
    await focusTerminal({ kind: "herdr", pane: "w2:p3", socket }, async (file, args, env) => {
      calls.push([file, args, env?.HERDR_SOCKET_PATH]);
      return "";
    });
  }
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  expect(calls).toEqual([
    [binary, ["agent", "focus", "w2:p3"], "/tmp/herdr/first server.sock"],
    [binary, ["agent", "focus", "w2:p3"], "/tmp/herdr/second server.sock"],
  ]);
});
