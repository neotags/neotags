import { describe, expect, it, vi } from "vitest";
import { HttpOnyxClient, OnyxError } from "../src/tools/onyx.js";
import { redact } from "../src/tools/redact.js";
import { createSlackReader, type SlackWebApi } from "../src/tools/slack.js";

describe("redact", () => {
  const cases: [string, string][] = [
    ["aws", "key AKIAIOSFODNN7EXAMPLE leaked"],
    ["slack", "token xoxb-1234567890-abcdefghijkl here"],
    ["github", "use ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3kL6 now"],
    ["jwt", "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 ok"],
    ["bearer", "curl -H 'Authorization: Bearer abcdef1234567890abcdef' x"],
    ["assignment", "export DB_PASSWORD=hunter2hunter2"],
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
    ["url creds", "postgres://admin:s3cretpass@db.internal:5432/app"],
    ["random token", "key=Zx9Qm2Lp7Vb4Nc8Rd1Ts6Yw3Uh5Je0KfGa"],
  ];
  it.each(cases)("redacts %s", (_n, input) => {
    const r = redact(input);
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).toContain("[REDACTED]");
  });
  it("keeps names of assignments and non-secret text", () => {
    const r = redact("password=hunter2hunter2 failed for user bob");
    expect(r.text).toBe("password=[REDACTED] failed for user bob");
  });
  it("leaves commit hashes, urls and prose alone", () => {
    const t = "fixed in 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b, see https://example.com/runbooks/restart-the-api-server";
    expect(redact(t)).toEqual({ text: t, count: 0 });
  });
});

describe("HttpOnyxClient", () => {
  const settings = { baseUrl: "https://onyx.test/", ingestionPath: "/api/ingestion", ccPairId: 1, apiKey: "k-secret" };
  const doc = { id: "d1", semantic_identifier: "t", sections: [{ text: "x" }], metadata: {} };

  it("upserts to {base}{path} with bearer key and cc_pair_id", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ document_id: "d1", already_existed: true })));
    const r = await new HttpOnyxClient(settings, f as unknown as typeof fetch).upsert(doc);
    expect(r).toEqual({ alreadyExisted: true });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://onyx.test/api/ingestion");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer k-secret");
    expect(JSON.parse(init.body)).toEqual({ document: doc, cc_pair_id: 1 });
  });

  it("deletes by encoded id", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await new HttpOnyxClient(settings, f as unknown as typeof fetch).delete("neotags-slack-C1-1.2/x");
    expect(f.mock.calls[0]![0]).toBe("https://onyx.test/api/ingestion/neotags-slack-C1-1.2%2Fx");
    expect(f.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("raises OnyxError with status and never echoes the key", async () => {
    const f = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const p = new HttpOnyxClient(settings, f as unknown as typeof fetch).upsert(doc);
    await expect(p).rejects.toMatchObject({ name: "OnyxError", status: 403 });
    await expect(p).rejects.not.toThrow(/k-secret/);
    expect(OnyxError).toBeDefined();
  });

  it("wraps network failures", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(new HttpOnyxClient(settings, f as unknown as typeof fetch).delete("x")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("createSlackReader", () => {
  const api = (over: Partial<SlackWebApi["conversations"]> = {}): SlackWebApi => ({
    conversations: {
      replies: vi.fn().mockResolvedValueOnce({
        messages: [
          { ts: "1", user: "U1", text: "hi <@U2> see <https://x.test/a|the doc> &amp; <#C9|ops>", files: [{ name: "log.txt" }] },
          { ts: "2", subtype: "channel_join", user: "U3", text: "joined" },
        ],
        response_metadata: { next_cursor: "c2" },
      }).mockResolvedValueOnce({ messages: [{ ts: "3", bot_id: "B1", username: "alertbot", text: "firing" }] }),
      info: vi.fn().mockResolvedValue({ channel: { id: "C1", name: "ops", is_private: false } }),
      ...over,
    },
    users: {
      info: vi.fn(async ({ user }) => ({ user: { real_name: user === "U1" ? "Ann" : "Bob", profile: { display_name: "" } } })),
    },
    chat: { getPermalink: vi.fn().mockResolvedValue({ permalink: "https://slack.test/p1" }) },
  });

  it("paginates, resolves names, cleans markup and skips joins", async () => {
    const msgs = await createSlackReader(api()).thread("C1", "1");
    expect(msgs.map((m) => m.ts)).toEqual(["1", "3"]);
    expect(msgs[0]).toMatchObject({ userName: "Ann", files: ["log.txt"], bot: false });
    expect(msgs[0]!.text).toBe("hi @Bob see the doc (https://x.test/a) & #ops");
    expect(msgs[1]).toMatchObject({ userName: "alertbot", bot: true });
  });

  it("falls back to the user id when lookup fails", async () => {
    const a = api();
    a.users.info = vi.fn().mockRejectedValue(new Error("nope"));
    expect(await createSlackReader(a).userName("U9")).toBe("U9");
  });

  it("classifies channels as public, private or dm", async () => {
    const r = (c: object) => createSlackReader(api({ info: vi.fn().mockResolvedValue({ channel: c }) })).channel("C1");
    expect((await r({ id: "C1", name: "ops" })).kind).toBe("public");
    expect((await r({ id: "C2", name: "secret", is_private: true })).kind).toBe("private");
    expect((await r({ id: "D1", is_im: true })).kind).toBe("dm");
    expect((await r({ id: "G1", is_mpim: true, is_private: true })).kind).toBe("dm"); // group DM is not a private channel
    expect((await createSlackReader(api({ info: vi.fn().mockResolvedValue({}) })).channel("C1")).kind).toBe("unknown");
  });

  it("reports a channel it cannot describe as unknown rather than failing", async () => {
    const boom = (data: object) => Object.assign(new Error("An API error occurred"), { data });
    const r = (data: object) =>
      createSlackReader(api({ info: vi.fn().mockRejectedValue(boom(data)) })).channel("C9");
    // private channel without groups:read (the real production case), DM scopes, bot not a member
    expect(await r({ error: "missing_scope", needed: "groups:read" })).toMatchObject({ id: "C9", kind: "unknown" });
    expect((await r({ error: "missing_scope", needed: "im:read" })).kind).toBe("unknown");
    expect((await r({ error: "missing_scope", needed: "mpim:read" })).kind).toBe("unknown");
    expect((await r({ error: "channel_not_found" })).kind).toBe("unknown");
    // a missing channels:read is a real misconfiguration: surface it
    await expect(r({ error: "missing_scope", needed: "channels:read" })).rejects.toThrow();
    await expect(r({ error: "ratelimited" })).rejects.toThrow();
  });

  it("returns the permalink", async () => {
    expect(await createSlackReader(api()).permalink("C1", "1")).toBe("https://slack.test/p1");
  });
});

describe("extractJson", () => {
  it("handles bare JSON, fences, prose, and code fences inside string values", async () => {
    const { extractJson } = await import("../src/agent/json.js");
    const obj = { a: "run:\n```\nls\n```", b: 1 };
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
    expect(extractJson("```json\n" + JSON.stringify(obj) + "\n```")).toEqual(obj);
    expect(extractJson("Sure! Here you go: " + JSON.stringify({ x: 1 }) + " done")).toEqual({ x: 1 });
    expect(() => extractJson("no braces")).toThrow(/no JSON/);
  });
});
