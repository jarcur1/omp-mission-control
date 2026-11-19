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

test("herdr-core addresses take precedence over inherited outer terminal identity", () => {
  expect(detectTerminal(instanceId, { ...tmux, HC_TERMINAL_ID: "t24" }, "darwin")).toEqual({
    kind: "herdr-core",
    terminal: "t24",
  });
  expect(detectTerminal(instanceId, { HC_TERMINAL_ID: "t1g" }, "linux")).toEqual({
    kind: "herdr-core",
    terminal: "t1g",
  });
  expect(detectTerminal(instanceId, { HC_TERMINAL_ID: "mini/t4" }, "darwin")).toEqual({
    kind: "herdr-core",
    terminal: "mini/t4",
  });
  expect(detectTerminal(instanceId, { HC_TERMINAL_ID: "reviewer" }, "darwin")).toEqual({
    kind: "unsupported",
    reason: "Herdr terminal identity is unavailable.",
  });
});

test("the Herdr multiplexer wins over herdr-core when both identities are present", () => {
  const socket = "/tmp/herdr.sock";
  const env = {
    ...tmux,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w2:p3",
    HERDR_SOCKET_PATH: socket,
    HC_TERMINAL_ID: "t24",
  };
  expect(detectTerminal(instanceId, env, "linux")).toEqual({ kind: "herdr", pane: "w2:p3", socket });
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

test("herdr-core focus prefers pane.focus then falls back to agent.focus", async () => {
  const binary = process.env.HERDR_APP_BIN_PATH || "herdr-app";
  const paneCalls: unknown[] = [];
  await focusTerminal({ kind: "herdr-core", terminal: "t24" }, async (file, args) => {
    paneCalls.push([file, args]);
    return "";
  });
  await focusTerminal({ kind: "herdr-core", terminal: "mini/t4" }, async (file, args) => {
    paneCalls.push([file, args]);
    return "";
  });
  expect(paneCalls).toEqual([
    [binary, ["do", "pane.focus", "--terminal", "t24"]],
    [binary, ["do", "pane.focus", "--terminal", "mini/t4"]],
  ]);

  const fallbackCalls: unknown[] = [];
  await focusTerminal({ kind: "herdr-core", terminal: "t29" }, async (file, args) => {
    fallbackCalls.push([file, args]);
    if (args[1] === "pane.focus") throw new Error("no such pane");
    return "";
  });
  expect(fallbackCalls).toEqual([
    [binary, ["do", "pane.focus", "--terminal", "t29"]],
    [binary, ["do", "agent.focus", "--terminal", "t29"]],
  ]);
});
