import { formatStatsDashboardUrl, startServer } from "@oh-my-pi/omp-stats";
import { isAbsolute } from "node:path";
import { powershellPath, runCommand, type RunCommand } from "./focus.ts";

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

export async function openTrace(sessionFile: string | undefined): Promise<string> {
  if (!sessionFile) throw new Error("No session file yet — send a message in that session first.");
  // Reuse OMP's server; opening /mc itself never starts ingestion or model calls.
  const server = await startServer();
  const url = traceUrl(formatStatsDashboardUrl(server.hostname, server.port), sessionFile);
  await openBrowser(url);
  return url;
}
