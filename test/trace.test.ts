import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { traceUrl } from "../src/trace.ts";

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
