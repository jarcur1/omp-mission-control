import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { Flag, is as hasErrorFlag } from "@oh-my-pi/pi-ai/error";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MissionControlDashboard } from "./src/dashboard.ts";
import { detectTerminal, focusTerminal } from "./src/focus.ts";
import { HEARTBEAT_MS, Registry } from "./src/registry.ts";
import { SessionState } from "./src/state.ts";
import { openTrace } from "./src/trace.ts";
import { cleanText, type DashboardAction, type LiveSession } from "./src/types.ts";

function isTerminal(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" && ctx.agent.kind === "main";
}

function restoredTask(ctx: ExtensionContext): string {
  const name = ctx.sessionManager.getSessionName();
  if (name) return cleanText(name);
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join(" ");
    if (text.trim() && !text.trim().startsWith("/")) return cleanText(text);
  }
  return "No task yet";
}

/** Factory-local state: OMP rebinds this extension for subagents in the same process. */
export default function missionControl(pi: ExtensionAPI): void {
  const instanceId = randomUUID();
  const startedAt = Date.now();
  const terminal = detectTerminal(instanceId);
  const registry = new Registry();
  const state = new SessionState();
  let context: ExtensionContext | undefined;
  let heartbeat: Timer | undefined;
  let live = false;
  let warned = false;
  let dashboardOpen = false;
  let publishing = false;
  let dirty = false;

  pi.setLabel("Mission Control");

  const reportError = (ctx: ExtensionContext, error: unknown): void => {
    const message = cleanText(error instanceof Error ? error.message : String(error), 300);
    pi.logger.warn(`Mission Control: ${message}`);
    ctx.ui.notify(`Mission Control: ${message}`, "error");
  };

  const publish = async (ctx: ExtensionContext): Promise<void> => {
    if (!live || !isTerminal(ctx)) return;
    context = ctx;
    dirty = true;
    if (publishing) return;
    publishing = true;
    try {
      // Coalesce concurrent events/ticks to one in-flight write and one latest snapshot.
      while (live && dirty) {
        dirty = false;
        const current = context;
        try {
          const cwd = current.sessionManager.getCwd();
          const model = current.models.current();
          const now = Date.now();
          const status = state.snapshot(current.isIdle(), current.getAsyncJobSnapshot()?.running.length ?? 0, now);
          const record: LiveSession = {
            version: 1, instanceId, pid: process.pid,
            sessionId: current.sessionManager.getSessionId(),
            sessionFile: current.sessionManager.getSessionFile(),
            project: cleanText(basename(cwd) || cwd), cwd,
            model: model ? `${model.provider}/${model.id}` : "No model",
            task: state.task || "No task yet", ...status, startedAt, updatedAt: now, terminal,
          };
          if (terminal.kind === "windows-terminal") {
            current.ui.setTitle(`${terminal.marker} ${record.status} | ${record.project} | ${cleanText(current.sessionManager.getSessionName() || record.task, 100)}`);
          }
          await registry.publish(record);
          warned = false;
        } catch (error) {
          // Presence failure must never block a model tool or end the OMP session.
          if (!warned && live) reportError(current, error);
          warned = true;
        }
      }
    } finally {
      publishing = false;
    }
  };

  const restore = async (ctx: ExtensionContext): Promise<void> => {
    if (!isTerminal(ctx)) return;
    context = ctx;
    state.reset(restoredTask(ctx));
    live = true;
    await publish(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!isTerminal(ctx)) return;
    await restore(ctx);
    if (live && !heartbeat) heartbeat = ctx.setInterval(async () => {
      if (context) await publish(context);
    }, HEARTBEAT_MS);
  });
  pi.on("session_switch", async (_event, ctx) => restore(ctx));
  pi.on("session_branch", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    if (event.reason === "prompt" && event.prompt.trim()) state.task = cleanText(event.prompt);
    await publish(ctx);
  });
  pi.on("agent_start", async (_event, ctx) => publish(ctx));
  // Completion/resolution events own individual waits. An older run can end after a newer run starts.
  pi.on("agent_end", async (_event, ctx) => publish(ctx));
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    const intent = event.intent || (event.args && typeof event.args === "object" && "i" in event.args && typeof event.args.i === "string" ? event.args.i : "");
    state.tools.set(event.toolCallId, { name: event.toolName, intent: cleanText(intent) });
    await publish(ctx);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    state.tools.delete(event.toolCallId);
    await publish(ctx);
  });
  pi.on("tool_approval_requested", async (event, ctx) => {
    if (!isTerminal(ctx) || event.sessionId !== ctx.sessionManager.getSessionId()) return;
    state.approvals.add(event.toolCallId);
    await publish(ctx);
  });
  pi.on("tool_approval_resolved", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    state.approvals.delete(event.toolCallId);
    await publish(ctx);
  });
  pi.on("plan_review_requested", async (event, ctx) => {
    if (!isTerminal(ctx) || event.sessionId !== ctx.sessionManager.getSessionId()) return;
    state.reviews.add(event.reviewId);
    await publish(ctx);
  });
  pi.on("plan_review_resolved", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    state.reviews.delete(event.reviewId);
    await publish(ctx);
  });
  pi.on("auto_retry_start", async (event, ctx) => {
    if (!isTerminal(ctx)) return;
    const retryAt = event.delayMs > 0 && hasErrorFlag(event.errorId, Flag.UsageLimit)
      ? Date.now() + event.delayMs
      : undefined;
    if (state.quotaRetryAt === retryAt) return;
    state.quotaRetryAt = retryAt;
    await publish(ctx);
  });
  pi.on("auto_retry_end", async (_event, ctx) => {
    if (!isTerminal(ctx) || state.quotaRetryAt === undefined) return;
    state.quotaRetryAt = undefined;
    await publish(ctx);
  });
  pi.on("auto_compaction_start", async (_event, ctx) => {
    if (!isTerminal(ctx)) return;
    state.compacting = true;
    await publish(ctx);
  });
  pi.on("auto_compaction_end", async (_event, ctx) => {
    if (!isTerminal(ctx)) return;
    state.compacting = false;
    await publish(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!isTerminal(ctx)) return;
    live = false;
    if (heartbeat) ctx.clearTimer(heartbeat);
    heartbeat = undefined;
    if (terminal.kind === "windows-terminal") ctx.ui.setTitle("");
    try { await registry.remove(instanceId); } catch (error) { pi.logger.warn(`Mission Control shutdown: ${String(error)}`); }
  });

  pi.registerCommand("mc", {
    description: "Mission Control: live sessions, terminal focus, and Open trace",
    handler: async (_args, ctx) => {
      if (!isTerminal(ctx)) return ctx.ui.notify("Mission Control needs an interactive OMP terminal.", "warning");
      if (dashboardOpen) return;
      dashboardOpen = true;
      let refresh: Timer | undefined;
      let refreshing = false;
      try {
        await publish(ctx);
        let sessions = await registry.list();
        let observed: LiveSession | undefined;
        const action = await ctx.ui.custom<DashboardAction | undefined>((tui, _theme, _keys, done) => {
          const dashboard = new MissionControlDashboard({
            currentInstanceId: instanceId, sessions,
            requestRender: () => tui.requestRender(),
            getHeight: () => Math.max(1, tui.terminal.rows - 2),
            onClose: () => done(undefined),
            onAction: result => {
              observed = sessions.find(session => session.instanceId === result.instanceId);
              if (refresh) ctx.clearTimer(refresh);
              done(result);
            },
          });
          refresh = ctx.setInterval(async () => {
            if (refreshing) return;
            refreshing = true;
            try {
              sessions = await registry.list();
              dashboard.update(sessions);
            } catch (error) {
              dashboard.update(sessions, error instanceof Error ? error.message : String(error));
            } finally { refreshing = false; }
          }, HEARTBEAT_MS);
          return dashboard;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
        if (!action) return;
        const selected = await registry.get(action.instanceId);
        if (!selected) throw new Error("That terminal is no longer live. Open /mc and choose again.");
        if (!observed || selected.sessionId !== observed.sessionId) throw new Error("That terminal switched sessions. Open /mc and choose again.");
        if (action.kind === "trace") {
          const url = await openTrace(selected.sessionFile);
          ctx.ui.notify(`Trace: ${url}`, "info");
        } else if (selected.instanceId !== instanceId) {
          await focusTerminal(selected.terminal);
        }
      } catch (error) {
        reportError(ctx, error);
      } finally {
        if (refresh) ctx.clearTimer(refresh);
        dashboardOpen = false;
      }
    },
  });
}
