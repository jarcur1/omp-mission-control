import { expect, test } from "bun:test";
import { SessionState } from "../src/state.ts";

test("a parallel tool ending cannot hide an unanswered question or approval", () => {
  const state = new SessionState();
  state.tools.set("question", { name: "ask", intent: "Choose a database" });
  state.tools.set("build", { name: "bash", intent: "Building project" });
  expect(state.snapshot(false, 1).status).toBe("waiting");
  state.tools.delete("build");
  state.approvals.add("first");
  state.approvals.add("second");
  state.approvals.delete("first");
  expect(state.snapshot(false, 0)).toEqual({ status: "waiting", detail: "Awaiting tool approval" });
  state.approvals.delete("second");
  expect(state.snapshot(false, 0).detail).toBe("Awaiting your answer");
  state.tools.delete("question");
  expect(state.snapshot(false, 0).status).toBe("working");
  expect(state.snapshot(true, 0).status).toBe("idle");
});

test("background work stays working after the foreground turn settles; switching drops old waits", () => {
  const state = new SessionState();
  expect(state.snapshot(true, 2)).toEqual({ status: "working", detail: "2 background jobs" });
  state.reviews.add("plan");
  state.compacting = true;
  expect(state.snapshot(true, 0).status).toBe("waiting");
  state.reset("New task");
  expect(state.snapshot(true, 0)).toEqual({ status: "idle", detail: "Ready for input" });
  expect(state.task).toBe("New task");
});
