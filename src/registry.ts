import * as crypto from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LiveSession, TerminalTarget } from "./types.ts";

export const HEARTBEAT_MS = 2000;
export const STALE_MS = 12000;

const MAX_RECORD_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_FILENAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const WT_MARKER_RE = /^\[MC:[a-f0-9-]+\]$/;
const TMUX_PANE_RE = /^%\d+$/;
const DIGITS_RE = /^\d+$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

export function registryDirectory(): string {
  const override = process.env.OMP_MC_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".omp", "mission-control");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function isNonEmptyCleanString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !CONTROL_CHARS_RE.test(value);
}

function isStringWithoutNul(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function validateTerminal(raw: unknown): TerminalTarget | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  if (!("kind" in raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "windows-terminal": {
      if (!("marker" in raw) || typeof raw.marker !== "string" || !WT_MARKER_RE.test(raw.marker)) {
        return null;
      }
      return { kind: "windows-terminal", marker: raw.marker };
    }
    case "tmux": {
      if (
        !("pane" in raw) ||
        typeof raw.pane !== "string" ||
        !TMUX_PANE_RE.test(raw.pane) ||
        !("socket" in raw) ||
        !isNonEmptyCleanString(raw.socket) ||
        !path.isAbsolute(raw.socket)
      ) {
        return null;
      }
      return { kind: "tmux", pane: raw.pane, socket: raw.socket };
    }
    case "wezterm": {
      if (!("pane" in raw) || typeof raw.pane !== "string" || !DIGITS_RE.test(raw.pane) ||
          !("socket" in raw) || !isNonEmptyCleanString(raw.socket)) {
        return null;
      }
      return { kind: "wezterm", pane: raw.pane, socket: raw.socket };
    }
    case "kitty": {
      if (
        !("window" in raw) ||
        typeof raw.window !== "string" ||
        !DIGITS_RE.test(raw.window) ||
        !("socket" in raw) ||
        !isNonEmptyCleanString(raw.socket)
      ) {
        return null;
      }
      return { kind: "kitty", window: raw.window, socket: raw.socket };
    }
    case "unsupported": {
      if (!("reason" in raw) || !isNonEmptyCleanString(raw.reason)) {
        return null;
      }
      return { kind: "unsupported", reason: raw.reason };
    }
    default:
      return null;
  }
}

function validateSession(raw: unknown, expectedInstanceId?: string): LiveSession | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  if (!("version" in raw) || raw.version !== 1) {
    return null;
  }
  if (!("instanceId" in raw) || typeof raw.instanceId !== "string" || !UUID_RE.test(raw.instanceId)) {
    return null;
  }
  if (expectedInstanceId !== undefined && raw.instanceId !== expectedInstanceId) {
    return null;
  }
  if (
    !("pid" in raw) ||
    typeof raw.pid !== "number" ||
    !Number.isInteger(raw.pid) ||
    raw.pid <= 0 ||
    !Number.isSafeInteger(raw.pid)
  ) {
    return null;
  }
  if (!("sessionId" in raw) || !isNonEmptyCleanString(raw.sessionId)) {
    return null;
  }
  const sessionFile = "sessionFile" in raw ? raw.sessionFile : undefined;
  if (sessionFile !== undefined && !isNonEmptyCleanString(sessionFile)) {
    return null;
  }
  if (!("project" in raw) || !isStringWithoutNul(raw.project)) {
    return null;
  }
  if (!("cwd" in raw) || !isNonEmptyCleanString(raw.cwd)) {
    return null;
  }
  if (!("model" in raw) || !isStringWithoutNul(raw.model)) {
    return null;
  }
  if (!("task" in raw) || !isStringWithoutNul(raw.task)) {
    return null;
  }
  if (
    !("status" in raw) ||
    (raw.status !== "working" && raw.status !== "idle" && raw.status !== "waiting")
  ) {
    return null;
  }
  if (!("detail" in raw) || !isStringWithoutNul(raw.detail)) {
    return null;
  }
  if (
    !("startedAt" in raw) ||
    typeof raw.startedAt !== "number" ||
    !Number.isFinite(raw.startedAt) ||
    raw.startedAt < 0
  ) {
    return null;
  }
  if (
    !("updatedAt" in raw) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isFinite(raw.updatedAt) ||
    raw.updatedAt < 0
  ) {
    return null;
  }
  if (!("terminal" in raw)) {
    return null;
  }
  const terminal = validateTerminal(raw.terminal);
  if (!terminal) {
    return null;
  }

  return {
    version: 1,
    instanceId: raw.instanceId,
    pid: raw.pid,
    sessionId: raw.sessionId,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    project: raw.project,
    cwd: raw.cwd,
    model: raw.model,
    task: raw.task,
    status: raw.status,
    detail: raw.detail,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    terminal,
  };
}

function isFresh(updatedAt: number, now: number): boolean {
  if (!Number.isFinite(now)) {
    return false;
  }
  return Math.abs(now - updatedAt) <= STALE_MS;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readRecordFile(filePath: string, expectedInstanceId: string): Promise<LiveSession | null> {
  let stat: Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return null;
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return null;
  }
  if (stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    return null;
  }

  const noFollowFlag =
    "O_NOFOLLOW" in fsConstants && typeof fsConstants.O_NOFOLLOW === "number"
      ? fsConstants.O_NOFOLLOW
      : 0;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag);
    const fstat = await handle.stat();
    if (!fstat.isFile() || fstat.size <= 0 || fstat.size > MAX_RECORD_BYTES) {
      return null;
    }

    const buffer = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
    let totalRead = 0;
    while (totalRead <= MAX_RECORD_BYTES) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
    }
    if (totalRead === 0 || totalRead > MAX_RECORD_BYTES) {
      return null;
    }

    const parsed: unknown = JSON.parse(buffer.subarray(0, totalRead).toString("utf8"));
    return validateSession(parsed, expectedInstanceId);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export class Registry {
  readonly directory: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(directory = registryDirectory()) {
    this.directory = directory;
  }

  publish(session: LiveSession): Promise<void> {
    const validated = validateSession(session);
    if (!validated) {
      return Promise.reject(new Error("Invalid LiveSession record"));
    }
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, "utf8") > MAX_RECORD_BYTES) {
      return Promise.reject(new Error(`Session record exceeds ${MAX_RECORD_BYTES} bytes`));
    }

    return this.enqueue(validated.instanceId, async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700).catch(() => {});

      const tmpPath = path.join(
        this.directory,
        `.${validated.instanceId}.${process.pid}.${crypto.randomUUID()}.tmp`,
      );
      const targetPath = path.join(this.directory, `${validated.instanceId}.json`);
      try {
        await fs.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.chmod(tmpPath, 0o600).catch(() => {});
        await fs.rename(tmpPath, targetPath);
      } catch (error) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  remove(instanceId: string): Promise<void> {
    if (typeof instanceId !== "string" || !UUID_RE.test(instanceId)) {
      return Promise.reject(new Error("Invalid instanceId UUID"));
    }

    return this.enqueue(instanceId, async () => {
      const targetPath = path.join(this.directory, `${instanceId}.json`);
      try {
        await fs.unlink(targetPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    });
  }

  async list(now = Date.now()): Promise<LiveSession[]> {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return [];
      }
      throw error;
    }

    const candidates: Array<{ filePath: string; instanceId: string }> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        continue;
      }
      const match = RECORD_FILENAME_RE.exec(entry.name);
      if (!match) {
        continue;
      }
      candidates.push({
        filePath: path.join(this.directory, entry.name),
        instanceId: match[1],
      });
    }

    const records = await Promise.all(
      candidates.map(({ filePath, instanceId }) => readRecordFile(filePath, instanceId)),
    );

    const live: LiveSession[] = [];
    for (const record of records) {
      if (!record) {
        continue;
      }
      if (!isFresh(record.updatedAt, now)) {
        continue;
      }
      if (!isPidAlive(record.pid)) {
        continue;
      }
      live.push(record);
    }

    live.sort((a, b) => a.startedAt - b.startedAt || a.instanceId.localeCompare(b.instanceId));
    return live;
  }

  async get(instanceId: string): Promise<LiveSession | undefined> {
    if (typeof instanceId !== "string" || !UUID_RE.test(instanceId)) {
      return undefined;
    }
    const sessions = await this.list(Date.now());
    return sessions.find((session) => session.instanceId === instanceId);
  }

  private enqueue(instanceId: string, op: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(instanceId) ?? Promise.resolve();
    const run = previous.then(op, op);
    const tail = run.then(
      () => {
        if (this.queues.get(instanceId) === tail) {
          this.queues.delete(instanceId);
        }
      },
      () => {
        if (this.queues.get(instanceId) === tail) {
          this.queues.delete(instanceId);
        }
      },
    );
    this.queues.set(instanceId, tail);
    return run;
  }
}
