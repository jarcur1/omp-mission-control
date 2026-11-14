import type { SessionStatus } from "./types.ts";
import { cleanText } from "./types.ts";

/** Waiting wins over parallel tools; completing one prompt must not clear another. */
export class SessionState {
  task = "";
  compacting = false;
  readonly tools = new Map<string, { name: string; intent: string }>();
  readonly approvals = new Set<string>();
  readonly reviews = new Set<string>();

  reset(task = ""): void {
    this.task = cleanText(task);
    this.compacting = false;
    this.tools.clear();
    this.approvals.clear();
    this.reviews.clear();
  }

  snapshot(idle: boolean, runningJobs: number): { status: SessionStatus; detail: string } {
    if (this.approvals.size) return { status: "waiting", detail: "Awaiting tool approval" };
    if (this.reviews.size) return { status: "waiting", detail: "Awaiting plan review" };
    if ([...this.tools.values()].some(tool => tool.name === "ask")) {
      return { status: "waiting", detail: "Awaiting your answer" };
    }
    if (this.compacting) return { status: "working", detail: "Compacting context" };
    const active = [...this.tools.values()].at(-1);
    if (active) return { status: "working", detail: cleanText(active.intent || active.name) };
    if (!idle || runningJobs > 0) return {
      status: "working", detail: runningJobs > 0 ? `${runningJobs} background job${runningJobs === 1 ? "" : "s"}` : "Agent working",
    };
    return { status: "idle", detail: "Ready for input" };
  }
}
