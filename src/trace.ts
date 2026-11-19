import { isAbsolute } from "node:path";
import { powershellPath, runCommand, type RunCommand } from "./focus.ts";

/** The two omp-stats entry points /trace uses. Loaded on demand so /mc can start without them. */
export type OmpStats = {
  startServer: () => Promise<{ hostname: string; port: number }>;
  formatStatsDashboardUrl: (hostname: string, port: number) => string;
};

export type OpenTraceOptions = {
  run?: RunCommand;
  loadStats?: () => Promise<OmpStats>;
};

export function traceUrl(base: string, sessionFile: string): string {
  if (!isAbsolute(sessionFile)) throw new Error("Trace requires a persisted session file.");
  const url = new URL(base);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The trace dashboard must run on loopback.");
  }
  // The same route and session-file key used by OMP's built-in /trace command.
  return `${url.origin}/#/traces?s=${encodeURIComponent(sessionFile)}`;
}

export async function openBrowser(url: string, run: RunCommand = runCommand): Promise<void> {
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop';Start-Process '${url.replaceAll("'", "''")}'`;
    await run(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  } else {
    await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  }
}

async function importOmpStats(): Promise<OmpStats> {
  // Same lazy import as OMP's built-in /trace. A static import is evaluated when
  // the extension loads, so plugin install on compiled OMP 18.22 remaps
  // @oh-my-pi/pi-utils to the host while bun still installs npm omp-stats 19,
  // which needs parseSpillUrl from pi-utils 19.
  return import("@oh-my-pi/omp-stats");
}

export async function openTrace(sessionFile: string | undefined, options: OpenTraceOptions = {}): Promise<string> {
  if (!sessionFile) throw new Error("No session file yet — send a message in that session first.");
  const run = options.run ?? runCommand;
  const loadStats = options.loadStats ?? importOmpStats;
  try {
    // Reuse OMP's server; opening /mc itself never starts ingestion or model calls.
    const { formatStatsDashboardUrl, startServer } = await loadStats();
    const server = await startServer();
    const url = traceUrl(formatStatsDashboardUrl(server.hostname, server.port), sessionFile);
    await openBrowser(url, run);
    return url;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Open trace could not start OMP's stats dashboard (${detail}). Run /trace in that session instead.`);
  }
}
