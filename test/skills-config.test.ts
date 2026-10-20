import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/index.js";
import { Router } from "../src/router/index.js";
import { allSkills, selectSkills } from "../src/skills/registry.js";
import type { Notifier, Task } from "../src/task.js";

const base = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y" };
const cfgFor = (env: Record<string, string> = {}, yaml = "") =>
  loadConfig({ ...base, ...(yaml && { NEOTAGS_CONFIG: "f" }), ...env }, () => yaml);
const names = (disabled: string[]) => selectSkills(allSkills(), disabled).map((s) => s.name);

describe("skills.disabled config", () => {
  it("defaults to nothing disabled", () => {
    expect(cfgFor().skills.disabled).toEqual([]);
  });

  it("reads the file, and the env var overrides it (comma-separated, blank clears)", () => {
    const yaml = "skills:\n  disabled: [kb-ask]\n";
    expect(cfgFor({}, yaml).skills.disabled).toEqual(["kb-ask"]);
    expect(cfgFor({ NEOTAGS_DISABLED_SKILLS: "kb-files, kb-ask" }, yaml).skills.disabled).toEqual(["kb-files", "kb-ask"]);
    expect(cfgFor({ NEOTAGS_DISABLED_SKILLS: "" }, yaml).skills.disabled).toEqual([]);
    expect(cfgFor({ NEOTAGS_DISABLED_SKILLS: "kb-ask" }).skills.disabled).toEqual(["kb-ask"]);
  });
});

describe("selectSkills", () => {
  it("keeps every skill by default and removes only the disabled ones", () => {
    expect(names([])).toEqual(["kb-collect", "kb-files", "kb-ask"]);
    expect(names(["kb-ask"])).toEqual(["kb-collect", "kb-files"]);
    expect(names(["kb-ask", "kb-files"])).toEqual(["kb-collect"]);
  });

  it("fails at startup on a name that is not a skill, so a typo cannot leave one running", () => {
    expect(() => names(["kb-asc"])).toThrow(/unknown skill\(s\): kb-asc \(known: kb-collect, kb-files, kb-ask\)/);
  });
});

describe("router with kb-ask disabled", () => {
  const notifier = (sent: string[]): Notifier => ({ reply: vi.fn(async (_t, text) => void sent.push(text)), react: vi.fn() });
  const task: Task = { id: "e", source: "slack", actor: { id: "U1" }, text: "what's the max bandwidth of the SN5600?", reply: { kind: "slack", channel: "C1" } };
  const log = pino({ level: "silent" });

  it("does not offer kb-ask, drops the 'questions go to kb-ask' rule, and answers an unmatched question with the help text", async () => {
    const sent: string[] = [];
    const chat = vi.fn(async () => ({ text: JSON.stringify({ skill: "none" }), usage: { promptTokens: 1, completionTokens: 1 } }));
    const router = new Router({ botName: "moose", notifier: notifier(sent), llm: { chat }, log, context: () => undefined, skills: selectSkills(allSkills(), ["kb-ask"]) });
    await router.handle(task);
    const system = (chat.mock.calls[0] as unknown as [{ content: string }[]])[0][0]!.content;
    expect(system).not.toMatch(/kb-ask/);
    expect(system).not.toMatch(/no other skill handles/);
    expect(sent[0]).toMatch(/not sure what you need/);
    expect(sent[0]).not.toMatch(/kb-ask/); // help text lists only what is registered
  });

  it("refuses to run a disabled skill even if the model names it", async () => {
    const sent: string[] = [];
    const chat = vi.fn(async () => ({ text: JSON.stringify({ skill: "kb-ask" }), usage: { promptTokens: 1, completionTokens: 1 } }));
    const router = new Router({ botName: "moose", notifier: notifier(sent), llm: { chat }, log, context: () => undefined, skills: selectSkills(allSkills(), ["kb-ask"]) });
    await router.handle(task);
    expect(sent[0]).toMatch(/not sure what you need/); // an unregistered name is "no skill", not an error
  });

  it("ignores button clicks for a disabled skill", async () => {
    const router = new Router({ botName: "moose", notifier: notifier([]), llm: undefined, log, context: () => undefined, skills: selectSkills(allSkills(), ["kb-files"]) });
    expect(await router.handleAction("kb-files:undo", "x", { id: "U1" }, "C1")).toBeUndefined();
  });
});
