import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HEARTBEAT_MS, Registry, registryDirectory, STALE_MS } from "../src/registry.ts";
import type { LiveSession, TerminalTarget } from "../src/types.ts";

function makeSession(overrides: Partial<LiveSession> = {}): LiveSession {
  const now = Date.now();
  const instanceId = overrides.instanceId ?? crypto.randomUUID();
  return {
    version: 1,
    instanceId,
    pid: process.pid,
    sessionId: "session-123",
    project: "Mission_Control",
    cwd: process.cwd(),
    model: "openai/gpt-6.1-sol",
    task: "Implementing registry",
    status: "working",
    detail: "Writing tests",
    startedAt: now - 1000,
    updatedAt: now,
    terminal: { kind: "windows-terminal", marker: `[MC:${instanceId}]` },
    ...overrides,
  };
}

async function getDeadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

describe("registryDirectory", () => {
  const originalEnv = process.env.OMP_MC_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OMP_MC_DIR;
    } else {
      process.env.OMP_MC_DIR = originalEnv;
    }
  });

  test("exports expected timing constants", () => {
    expect(HEARTBEAT_MS).toBe(2000);
    expect(STALE_MS).toBe(12000);
  });

  test("falls back to homedir/.omp/mission-control when OMP_MC_DIR is unset or blank", () => {
    delete process.env.OMP_MC_DIR;
    expect(registryDirectory()).toBe(path.join(os.homedir(), ".omp", "mission-control"));

    process.env.OMP_MC_DIR = "   ";
    expect(registryDirectory()).toBe(path.join(os.homedir(), ".omp", "mission-control"));
  });

  test("uses OMP_MC_DIR when set", () => {
    const customDir = path.join(os.tmpdir(), "custom-mc-dir");
    process.env.OMP_MC_DIR = customDir;
    expect(registryDirectory()).toBe(path.resolve(customDir));
  });
});

describe("Registry", () => {
  let tmpRoot: string;
  let regDir: string;
  let registry: Registry;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mc-registry-"));
    regDir = path.join(tmpRoot, "registry");
    registry = new Registry(regDir);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test("returns empty list and undefined get when directory is missing", async () => {
    expect(await registry.list()).toEqual([]);
    expect(await registry.get(crypto.randomUUID())).toBeUndefined();
    await expect(fs.access(regDir)).rejects.toThrow();
  });

  test("propagates actual directory IO errors", async () => {
    const fileAsDir = path.join(tmpRoot, "not-a-directory");
    await fs.writeFile(fileAsDir, "blocking file", "utf8");
    const badRegistry = new Registry(fileAsDir);

    await expect(badRegistry.list()).rejects.toThrow();
    await expect(badRegistry.get(crypto.randomUUID())).rejects.toThrow();
  });

  test("publishes, lists, gets, and removes sessions atomically", async () => {
    const now = Date.now();
    const s1 = makeSession({
      startedAt: now - 5000,
      updatedAt: now,
      sessionFile: path.join(tmpRoot, "session.jsonl"),
    });
    const s2 = makeSession({
      startedAt: now - 2000,
      updatedAt: now,
      status: "idle",
      task: "",
      detail: "",
      terminal: { kind: "tmux", pane: "%12", socket: "/tmp/tmux-1000/default" },
    });

    await registry.publish(s1);
    await registry.publish(s2);

    const entries = await fs.readdir(regDir);
    expect(entries.sort()).toEqual([`${s1.instanceId}.json`, `${s2.instanceId}.json`].sort());

    if (process.platform !== "win32") {
      const dirStat = await fs.stat(regDir);
      const fileStat = await fs.stat(path.join(regDir, `${s1.instanceId}.json`));
      expect(dirStat.mode & 0o777).toBe(0o700);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    const listed = await registry.list(now);
    expect(listed).toEqual([s1, s2]);
    expect(await registry.get(s1.instanceId)).toEqual(s1);

    const updatedS1 = { ...s1, status: "waiting" as const, detail: "Awaiting input" };
    await registry.publish(updatedS1);
    expect(await registry.get(s1.instanceId)).toEqual(updatedS1);

    await registry.remove(s1.instanceId);
    expect(await registry.get(s1.instanceId)).toBeUndefined();
    expect(await registry.list(now)).toEqual([s2]);

    await registry.remove(s1.instanceId);
    await expect(registry.remove("not-a-uuid")).rejects.toThrow();
  });

  test("accepts all valid terminal target variants", async () => {
    const now = Date.now();
    const targets: TerminalTarget[] = [
      { kind: "windows-terminal", marker: `[MC:${crypto.randomUUID()}]` },
      { kind: "herdr", pane: "w1:p2", socket: "/tmp/herdr/work session/herdr.sock" },
      { kind: "herdr", pane: "w1:p2", socket: "C:\\Users\\test\\AppData\\Roaming\\herdr\\herdr.sock" },
      { kind: "tmux", pane: "%0", socket: "/tmp/tmux-1000/default" },
      { kind: "wezterm", pane: "42", socket: "/tmp/wezterm.sock" },
      { kind: "kitty", window: "7", socket: "unix:/tmp/kitty-1" },
      { kind: "unsupported", reason: "No terminal integration" },
    ];

    const sessions = targets.map((terminal, idx) =>
      makeSession({ startedAt: now + idx, updatedAt: now, terminal }),
    );
    for (const session of sessions) {
      await registry.publish(session);
    }

    expect(await registry.list(now)).toEqual(sessions);
  });

  test("filters stale, future-skewed, and dead-pid records without deleting files", async () => {
    await fs.mkdir(regDir, { recursive: true });
    const now = Date.now();
    const deadPid = await getDeadPid();

    const boundaryFresh = makeSession({ updatedAt: now - STALE_MS, startedAt: now - 20_000 });
    const stale = makeSession({ updatedAt: now - STALE_MS - 1, startedAt: now - 20_000 });
    const futureSkew = makeSession({ updatedAt: now + STALE_MS + 1, startedAt: now - 1000 });
    const dead = makeSession({ pid: deadPid, updatedAt: now, startedAt: now - 1000 });

    await registry.publish(boundaryFresh);
    await registry.publish(stale);
    await registry.publish(futureSkew);
    await registry.publish(dead);

    const listed = await registry.list(now);
    expect(listed).toEqual([boundaryFresh]);

    // Dead / stale files must not be deleted by list() or get().
    const filesOnDisk = await fs.readdir(regDir);
    expect(filesOnDisk).toContain(`${stale.instanceId}.json`);
    expect(filesOnDisk).toContain(`${futureSkew.instanceId}.json`);
    expect(filesOnDisk).toContain(`${dead.instanceId}.json`);

    expect(await registry.get(dead.instanceId)).toBeUndefined();
    const staleLive = makeSession({ updatedAt: Date.now() - STALE_MS - 500 });
    await registry.publish(staleLive);
    expect(await registry.get(staleLive.instanceId)).toBeUndefined();
    expect(await fs.readdir(regDir)).toContain(`${staleLive.instanceId}.json`);
  });

  test("rejects corrupt, truncated, oversize, mismatched, invalid, and symlink files while preserving unknown entries", async () => {
    await fs.mkdir(regDir, { recursive: true });
    const now = Date.now();
    const valid = makeSession({ updatedAt: now });
    await registry.publish(valid);

    const corruptId = crypto.randomUUID();
    const truncatedId = crypto.randomUUID();
    const emptyId = crypto.randomUUID();
    const oversizeId = crypto.randomUUID();
    const mismatchId = crypto.randomUUID();
    const invalidVersionId = crypto.randomUUID();
    const invalidPidId = crypto.randomUUID();
    const invalidNanId = crypto.randomUUID();
    const invalidTerminalId = crypto.randomUUID();
    const symlinkId = crypto.randomUUID();

    await fs.writeFile(path.join(regDir, `${corruptId}.json`), "{not valid json", "utf8");
    await fs.writeFile(
      path.join(regDir, `${truncatedId}.json`),
      `{"version":1,"instanceId":"${truncatedId}"`,
      "utf8",
    );
    await fs.writeFile(path.join(regDir, `${emptyId}.json`), "", "utf8");
    await fs.writeFile(
      path.join(regDir, `${oversizeId}.json`),
      JSON.stringify(makeSession({ instanceId: oversizeId, updatedAt: now, detail: "x".repeat(70_000) })),
      "utf8",
    );
    await fs.writeFile(
      path.join(regDir, `${mismatchId}.json`),
      JSON.stringify(makeSession({ instanceId: crypto.randomUUID(), updatedAt: now })),
      "utf8",
    );
    await fs.writeFile(
      path.join(regDir, `${invalidVersionId}.json`),
      JSON.stringify({ ...makeSession({ instanceId: invalidVersionId, updatedAt: now }), version: 2 }),
      "utf8",
    );
    await fs.writeFile(
      path.join(regDir, `${invalidPidId}.json`),
      JSON.stringify(makeSession({ instanceId: invalidPidId, updatedAt: now, pid: 0 })),
      "utf8",
    );
    await fs.writeFile(
      path.join(regDir, `${invalidNanId}.json`),
      JSON.stringify({ ...makeSession({ instanceId: invalidNanId, updatedAt: now }), updatedAt: null }),
      "utf8",
    );
    await fs.writeFile(
      path.join(regDir, `${invalidTerminalId}.json`),
      JSON.stringify({
        ...makeSession({ instanceId: invalidTerminalId, updatedAt: now }),
        terminal: { kind: "tmux", pane: "12", socket: "relative/socket" },
      }),
      "utf8",
    );

    let symlinkCreated = false;
    try {
      await fs.symlink(path.join(regDir, `${valid.instanceId}.json`), path.join(regDir, `${symlinkId}.json`));
      symlinkCreated = true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "EPERM") {
        throw error;
      }
    }

    await fs.writeFile(path.join(regDir, "foreign.txt"), "keep me", "utf8");
    await fs.writeFile(path.join(regDir, "not-a-uuid.json"), JSON.stringify(valid), "utf8");
    await fs.mkdir(path.join(regDir, "nested-dir"));

    expect(await registry.list(now)).toEqual([valid]);

    const remaining = await fs.readdir(regDir);
    expect(remaining).toContain(`${corruptId}.json`);
    expect(remaining).toContain(`${truncatedId}.json`);
    expect(remaining).toContain(`${oversizeId}.json`);
    expect(remaining).toContain("foreign.txt");
    expect(remaining).toContain("not-a-uuid.json");
    expect(remaining).toContain("nested-dir");
    if (symlinkCreated) {
      expect(remaining).toContain(`${symlinkId}.json`);
      expect(await registry.get(symlinkId)).toBeUndefined();
    }
  });

  test("rejects invalid terminal syntax on publish", async () => {
    const badTerminals: TerminalTarget[] = [
      { kind: "windows-terminal", marker: `MC:${crypto.randomUUID()}` },
      { kind: "windows-terminal", marker: "[MC:NOT_HEX]" },
      { kind: "herdr", pane: "reviewer", socket: "/tmp/herdr.sock" },
      { kind: "herdr", pane: "w1:p2", socket: " " },
      { kind: "herdr", pane: "w1:p2", socket: "relative/herdr.sock" },
      { kind: "tmux", pane: "12", socket: "/tmp/tmux-1000/default" },
      { kind: "tmux", pane: "%12", socket: "relative/socket" },
      { kind: "wezterm", pane: "pane-1", socket: "/tmp/wezterm.sock" },
      { kind: "wezterm", pane: "1", socket: "  " },
      { kind: "kitty", window: "abc", socket: "unix:/tmp/kitty" },
      { kind: "kitty", window: "1", socket: "  " },
      { kind: "unsupported", reason: "  " },
    ];

    for (const terminal of badTerminals) {
      await expect(registry.publish(makeSession({ terminal }))).rejects.toThrow();
    }
  });

  test("serializes overlapping publishes and removes per instance so late writes cannot resurrect", async () => {
    const id = crypto.randomUUID();
    const base = makeSession({ instanceId: id });

    for (let i = 0; i < 15; i += 1) {
      const ops: Array<Promise<void>> = [
        registry.publish({ ...base, task: `task-a-${i}`, updatedAt: Date.now() }),
        registry.publish({ ...base, task: `task-b-${i}`, updatedAt: Date.now() }),
        registry.remove(id),
      ];
      await Promise.all(ops);
      expect(await registry.get(id)).toBeUndefined();
      await expect(fs.access(path.join(regDir, `${id}.json`))).rejects.toThrow();
    }

    await Promise.all([
      registry.publish({ ...base, task: "first", updatedAt: Date.now() }),
      registry.publish({ ...base, task: "second", updatedAt: Date.now() }),
      registry.publish({ ...base, task: "third", updatedAt: Date.now() }),
    ]);
    const finalSession = await registry.get(id);
    expect(finalSession?.task).toBe("third");
  });

  test("recovers per-instance queue after an IO error", async () => {
    await fs.writeFile(regDir, "blocking file", "utf8");
    const session = makeSession();

    await expect(registry.publish(session)).rejects.toThrow();

    await fs.rm(regDir, { force: true });
    await registry.publish(session);
    expect(await registry.get(session.instanceId)).toEqual(session);
  });
});
