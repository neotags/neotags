import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Shape checks for the O2 assistant SSE contract (docs/design/002-o2-gateway-contract.md).
const dir = join(import.meta.dirname, "fixtures", "o2");

const EVENT_TYPES = new Set([
  "title", "message_delta", "tool_call", "tool_result", "navigation_action", "error", "complete", "cancelled",
]);
const TERMINAL = new Set(["complete", "error", "cancelled"]);

type Event = { type: string; [key: string]: unknown };

/** Parses a stream the way it must look on the wire: `data: <one-line JSON>` or `: comment` frames, each ending in a blank line. */
function parseStream(raw: string): Event[] {
  expect(raw.endsWith("\n\n")).toBe(true);
  const frames = raw.slice(0, -2).split("\n\n");
  const events: Event[] = [];
  for (const frame of frames) {
    expect(frame).not.toContain("\n");
    if (frame.startsWith(":")) continue;
    expect(frame.startsWith("data: {")).toBe(true);
    events.push(JSON.parse(frame.slice("data: ".length)) as Event);
  }
  return events;
}

function checkEvent(e: Event): void {
  expect(EVENT_TYPES.has(e.type)).toBe(true);
  switch (e.type) {
    case "title":
      expect(typeof e.title).toBe("string");
      break;
    case "message_delta":
      expect(typeof e.content).toBe("string");
      break;
    case "tool_call":
      expect(typeof e.tool).toBe("string");
      expect(typeof e.call_id).toBe("string");
      expect(typeof e.message).toBe("string");
      break;
    case "tool_result":
      expect(typeof e.tool).toBe("string");
      expect(typeof e.call_id).toBe("string");
      expect(typeof e.success).toBe("boolean");
      expect(e).not.toHaveProperty("response");
      break;
    case "navigation_action":
      expect(["load_query", "navigate_direct"]).toContain(e.action);
      expect(typeof e.resource_type).toBe("string");
      expect(typeof e.label).toBe("string");
      expect(typeof e.target).toBe("object");
      break;
    case "error":
      expect(typeof e.error).toBe("string");
      // Either would make the O2 panel claim the user lacks permission or restart the session.
      expect(String(e.error)).not.toMatch(/unauthorized|forbidden|not\s+authorized|permission\s*denied/i);
      expect(e.code).not.toBe("session_owner_unavailable");
      break;
    case "complete":
      expect(String(e.trace_id)).toMatch(/^[0-9a-f]{32}$/);
      break;
  }
}

describe("O2 event fixtures", () => {
  const files = readdirSync(join(dir, "events")).filter((f) => f.endsWith(".json"));
  it("cover every event type", () => {
    const types = new Set(files.map((f) => (JSON.parse(readFileSync(join(dir, "events", f), "utf8")) as Event).type));
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
  });
  it.each(files)("%s is one line of valid JSON", (f) => {
    const raw = readFileSync(join(dir, "events", f), "utf8").trimEnd();
    expect(raw).not.toContain("\n");
    checkEvent(JSON.parse(raw) as Event);
  });
});

describe("O2 stream fixtures", () => {
  const files = readdirSync(join(dir, "streams")).filter((f) => f.endsWith(".sse"));
  it.each(files)("%s follows the contract", (f) => {
    const events = parseStream(readFileSync(join(dir, "streams", f), "utf8"));
    events.forEach(checkEvent);

    // Exactly one terminal event, and it is the last one.
    expect(events.filter((e) => TERMINAL.has(e.type))).toHaveLength(1);
    expect(TERMINAL.has(events.at(-1)!.type)).toBe(true);

    // At most one title and one navigation_action per turn.
    expect(events.filter((e) => e.type === "title").length).toBeLessThanOrEqual(1);
    expect(events.filter((e) => e.type === "navigation_action").length).toBeLessThanOrEqual(1);

    // Every tool_result answers an earlier tool_call with the same call_id, once.
    const open = new Set<string>();
    for (const e of events) {
      if (e.type === "tool_call") {
        expect(open.has(e.call_id as string)).toBe(false);
        open.add(e.call_id as string);
      } else if (e.type === "tool_result") {
        expect(open.delete(e.call_id as string)).toBe(true);
      }
    }
    if (events.at(-1)!.type === "complete") expect(open.size).toBe(0);
  });
});

describe("O2 query request fixture", () => {
  it("carries the fields moose reads", () => {
    const req = JSON.parse(readFileSync(join(dir, "request", "query-request.json"), "utf8")) as {
      headers: Record<string, string>;
      body: Record<string, unknown> & { context: Record<string, unknown> };
    };
    expect(req.headers).not.toHaveProperty("authorization");
    for (const h of ["x-o2-agent-key", "x-o2-user-email", "x-o2-assistant-session-id", "x-o2-assistant-turn-id", "traceparent"]) {
      expect(req.headers).toHaveProperty(h);
    }
    expect(typeof req.body.query).toBe("string");
    expect(Array.isArray(req.body.history)).toBe(true);
    expect(typeof req.body.context.org_id).toBe("string");
  });
});
