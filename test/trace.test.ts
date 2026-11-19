import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { openTrace, traceUrl } from "../src/trace.ts";

test("trace targets the selected session, including paths with URL syntax and Unicode", () => {
  const file = resolve("session #1 & task=other/日本語.jsonl");
  const url = new URL(traceUrl("http://127.0.0.1:3847", file));
  expect(url.hash.startsWith("#/traces?")).toBe(true);
  expect(new URLSearchParams(url.hash.split("?")[1]).get("s")).toBe(file);
});

test("trace cannot send a session path to a remote host or navigate an unsaved session", () => {
  expect(() => traceUrl("https://remote.example", resolve("session.jsonl"))).toThrow("loopback");
  expect(() => traceUrl("http://127.0.0.1:3847", "relative.jsonl")).toThrow("persisted");
});

test("openTrace starts the host dashboard only after /mc is already running", async () => {
  const file = resolve("session.jsonl");
  const opened: string[] = [];
  const url = await openTrace(file, {
    run: async (_cmd, args) => {
      opened.push(args.at(-1) ?? "");
      return "";
    },
    loadStats: async () => ({
      startServer: async () => ({ hostname: "127.0.0.1", port: 3847 }),
      formatStatsDashboardUrl: (hostname, port) => `http://${hostname}:${port}`,
    }),
  });
  expect(new URLSearchParams(new URL(url).hash.split("?")[1]).get("s")).toBe(file);
  expect(opened.some(arg => arg.includes("127.0.0.1:3847"))).toBe(true);
});

test("openTrace tells the operator to use /trace when host stats cannot load", async () => {
  expect(openTrace(resolve("session.jsonl"), {
    run: async () => "",
    loadStats: async () => {
      throw new Error("Export named 'parseSpillUrl' not found in module 'omp-legacy-pi-bundled:@oh-my-pi/pi-utils'.");
    },
  })).rejects.toThrow("/trace");
});
