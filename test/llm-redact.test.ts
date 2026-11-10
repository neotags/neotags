import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it, vi } from "vitest";
import { PiLlmClient } from "../src/agent/llm.js";
import { createGateway } from "../src/agent/models.js";
import { loadConfig } from "../src/config/index.js";
import { startTelemetry } from "../src/telemetry/index.js";

// Its own file: counting redact() calls needs the module mocked for everything that imports it.
const redacted = vi.hoisted(() => [] as string[]);
vi.mock("../src/tools/redact.js", async (original) => {
  const m = await original<typeof import("../src/tools/redact.js")>();
  return { ...m, redact: (s: string) => (redacted.push(s), m.redact(s)) };
});

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ exporter })!;
const { policy } = createGateway(loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", LLM_MODEL: "m1" }));
const reply = {
  role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", model: "m1",
  usage: { input: 30, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 37 },
} as never;

describe("PiLlmClient retries", () => {
  it("redact the prompt once for all attempts, and record it on every attempt's span", async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error("503 Service Unavailable")).mockRejectedValueOnce(new Error("503 Service Unavailable")).mockResolvedValueOnce(reply);
    const llm = new PiLlmClient({ complete, timeoutMs: 10_000, maxRetries: 2, sleep: async () => {}, policy, captureContent: true });
    await expect(llm.chat([{ role: "system", content: "the system prompt" }, { role: "user", content: "the question" }])).resolves.toMatchObject({ text: "ok" });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(redacted.filter((s) => s === "the system prompt" || s === "the question")).toEqual(["the system prompt", "the question"]);
    await telemetry.flush();
    const inputs = exporter.getFinishedSpans().filter((s) => s.name === "chat m1").map((s) => s.attributes["gen_ai.input.messages"]);
    expect(inputs).toHaveLength(3);
    expect(new Set(inputs)).toEqual(new Set([JSON.stringify([{ role: "system", content: "the system prompt" }, { role: "user", content: "the question" }])]));
  });
});
