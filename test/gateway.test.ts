import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { Dedupe } from "../src/gateway/dedupe.js";
import { isDmMessage } from "../src/gateway/dm.js";
import { stripMention } from "../src/gateway/mention.js";
import { authorize } from "../src/guardrails/policy.js";

describe("stripMention", () => {
  it("removes the bot mention and leading punctuation", () => {
    expect(stripMention("<@U0BOT>, record the knowledge", "U0BOT")).toBe("record the knowledge");
  });
  it("handles labelled and mid-sentence mentions, leaves other users", () => {
    expect(stripMention("hey <@U0BOT|moose> please ask <@U2>", "U0BOT")).toBe("hey please ask <@U2>");
  });
});

describe("Dedupe", () => {
  it("flags repeats within ttl and forgets after", () => {
    let t = 0;
    const d = new Dedupe(1000, 10, () => t);
    expect(d.isDuplicate("a")).toBe(false);
    expect(d.isDuplicate("a")).toBe(true);
    t = 2000;
    expect(d.isDuplicate("a")).toBe(false);
  });
  it("evicts oldest beyond max", () => {
    const d = new Dedupe(1e9, 2);
    d.isDuplicate("a"); d.isDuplicate("b"); d.isDuplicate("c");
    expect(d.isDuplicate("a")).toBe(false);
  });
});

describe("authorize", () => {
  it("allows when lists empty, enforces when set", () => {
    expect(authorize({ allowedChannels: [], allowedUsers: [] }, "C1", "U1").ok).toBe(true);
    expect(authorize({ allowedChannels: ["C2"], allowedUsers: [] }, "C1", "U1").ok).toBe(false);
    expect(authorize({ allowedChannels: [], allowedUsers: ["U2"] }, "C1", "U1").ok).toBe(false);
  });
});

describe("loadConfig", () => {
  const env = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
  it("applies defaults without a file", () => {
    const c = loadConfig(env);
    expect(c.bot.name).toBe("neotags");
    expect(c.onyx.ingestionPath).toBe("/api/ingestion");
  });
  it("keeps private-channel recording off unless enabled", () => {
    expect(loadConfig(env).slack.allowPrivateChannels).toBe(false);
    const on = loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => "slack:\n  allowPrivateChannels: true\n");
    expect(on.slack.allowPrivateChannels).toBe(true);
  });
  it("reads yaml and requires secrets", () => {
    const c = loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => "bot:\n  name: moose\n");
    expect(c.bot.name).toBe("moose");
    expect(() => loadConfig({})).toThrow(/SLACK_BOT_TOKEN/);
  });
});

describe("stripMention escaping", () => {
  it("treats the bot id literally", () => {
    expect(stripMention("<@U.BOT> hi <@UXBOT>", "U.BOT")).toBe("hi <@UXBOT>");
  });
});

describe("isDmMessage", () => {
  it("accepts a plain user DM and a file upload", () => {
    expect(isDmMessage({ channel: "D1", ts: "1", channel_type: "im", user: "U1", text: "hi" })).toBe(true);
    expect(isDmMessage({ channel: "D1", ts: "2", channel_type: "im", subtype: "file_share", user: "U1", text: "" })).toBe(true);
  });
  it("rejects channel traffic, bot echoes, edits and subtypes without user text", () => {
    expect(isDmMessage({ channel: "C1", ts: "1", channel_type: "channel", user: "U1", text: "hi" })).toBe(false);
    expect(isDmMessage({ channel: "D1", ts: "1", channel_type: "im", subtype: "bot_message", bot_id: "B1", text: "hi" })).toBe(false);
    expect(isDmMessage({ channel: "D1", ts: "1", channel_type: "im", bot_id: "B1", user: "U1", text: "hi" })).toBe(false);
    expect(isDmMessage({ channel: "D1", ts: "1", channel_type: "im", subtype: "message_changed" })).toBe(false);
    expect(isDmMessage({ channel: "G1", ts: "1", channel_type: "group", user: "U1", text: "hi" })).toBe(false);
    expect(isDmMessage({ channel: "G1", ts: "1", channel_type: "mpim", user: "U1", text: "hi" })).toBe(false);
  });
});

describe("Dedupe.forget", () => {
  it("lets a failed event be reprocessed", () => {
    const d = new Dedupe();
    expect(d.isDuplicate("e1")).toBe(false);
    d.forget("e1");
    expect(d.isDuplicate("e1")).toBe(false);
  });
});
