import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import missionControl from "../index.ts";
import { Registry } from "../src/registry.ts";
import type { LiveSession } from "../src/types.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

function sessionHarness() {
  const handlers = new Map<string, Handler>();
  const ticks: Array<() => Promise<void>> = [];
  let cwd = process.cwd();
  let idle = true;
  const ctx = {
    mode: "tui", agent: { kind: "main" }, cwd,
    models: { current: () => undefined }, isIdle: () => idle,
    getAsyncJobSnapshot: () => null,
    sessionManager: {
      getCwd: () => cwd, getSessionId: () => "test-session", getSessionFile: () => undefined,
      getSessionName: () => "Lifecycle regression", getBranch: () => [],
    },
    ui: { setTitle() {}, notify() {} },
    setInterval(callback: () => Promise<void>) { ticks.push(callback); return 1; }, clearTimer() {},
  } as unknown as ExtensionContext;
  missionControl({
    setLabel() {}, registerCommand() {}, logger: { warn() {} },
    on(name: string, handler: Handler) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI);
  return {
    ctx, ticks,
    move(value: string) { cwd = value; },
    busy() { idle = false; },
    async event(name: string, data: Record<string, unknown> = {}) { await handlers.get(name)!({ type: name, ...data }, ctx); },
  };
}

test("late run completion preserves a newer question, and idle moves update the global project row", async () => {
  const records: LiveSession[] = [];
  const write = spyOn(Registry.prototype, "publish").mockImplementation(async record => { records.push(record); });
  const remove = spyOn(Registry.prototype, "remove").mockResolvedValue();
  try {
    const h = sessionHarness();
    await h.event("session_start");
    h.busy();
    await h.event("tool_execution_start", { toolCallId: "question-B", toolName: "ask", args: {} });
    await h.event("agent_end");
    expect(records.at(-1)?.status).toBe("waiting");
    await h.event("tool_execution_end", { toolCallId: "question-B" });
    expect(records.at(-1)?.status).toBe("working");
    h.move("/different/project-beta");
    await h.ticks[0]();
    expect(records.at(-1)?.cwd).toBe("/different/project-beta");
    expect(records.at(-1)?.project).toBe("project-beta");
    await h.event("session_shutdown");
  } finally { write.mockRestore(); remove.mockRestore(); }
});

test("slow presence IO coalesces events and publishes the newest state instead of queuing old heartbeats", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const records: LiveSession[] = [];
  const write = spyOn(Registry.prototype, "publish").mockImplementation(async record => {
    records.push(record);
    if (records.length === 1) await gate;
  });
  const remove = spyOn(Registry.prototype, "remove").mockResolvedValue();
  try {
    const h = sessionHarness();
    const startup = h.event("session_start");
    for (let i = 0; i < 20; i++) await h.event("agent_start");
    await h.event("tool_approval_requested", { sessionId: "test-session", toolCallId: "approval" });
    expect(records.length).toBe(1);
    release();
    await startup;
    expect(records.length).toBe(2);
    expect(records.at(-1)?.status).toBe("waiting");
    expect(records.at(-1)?.detail).toBe("Awaiting tool approval");
    await h.event("session_shutdown");
    await h.event("agent_start");
    expect(records.length).toBe(2);
  } finally { release(); write.mockRestore(); remove.mockRestore(); }
});
