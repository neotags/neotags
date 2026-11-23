import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/index.js";
import { routinePackIssues } from "../src/config/routines.js";

const env = { SLACK_BOT_TOKEN: "x", SLACK_SIGNING_SECRET: "y", MOOSE_JOB_KEY: "test-job-key" };

const agent = () => ({
  kind: "agent",
  enabled: false,
  trigger: { schedule: "0 10 * * 1", timeZone: "Asia/Shanghai" },
  owner: { slack: "C0TEST" },
  packs: ["assistant"],
  mcp: ["o2prod"],
  instructions: "Review the past week's alerts.",
  context: { o2Org: "prod", window: "7d" },
  budget: { wallClockSec: 900, maxSteps: 20 },
  delivery: { notify: "when_findings", slack: [{ channel: "C0TEST", lang: "en" }] },
});

const pipeline = () => ({
  kind: "pipeline",
  type: "alert-triage",
  trigger: { schedule: "0 9 * * *", timeZone: "Asia/Shanghai" },
  owner: { slack: "C0TEST" },
  packs: ["classify"],
  params: { sources: [{ kind: "o2", org: "prod" }], window: "24h" },
  delivery: {
    slack: [{ channel: "C0TEAM", lang: "zh", mention: "<!subteam^S0123>" }],
    confluence: { space: "OPS", parent: "12345", monthlyFolder: true },
  },
});

function base(): Record<string, any> {
  return {
    skillPacks: { packs: ["assistant", "classify"] },
    mcp: { servers: [{ name: "o2prod", url: "http://o2.example.com/mcp", allowTools: ["SearchSQL"] }] },
    jobsApi: { enabled: true, callers: { job: { keyFromEnv: "MOOSE_JOB_KEY" } } },
    outbox: {
      slack: { allowedChannels: ["C0TEST", "C0TEAM"], testChannel: "C0TEST" },
      confluence: { baseUrl: "https://wiki.example.com/wiki", allowedSpaces: ["OPS"], testParent: "999" },
    },
    artifacts: { s3: { bucket: "test-bucket" } },
    routines: { "weekly-review": agent(), "daily-triage": pipeline() },
  };
}

/** Load `base()` changed by `edit`. */
const load = (edit: (c: Record<string, any>) => void = () => {}) => () => {
  const c = base();
  edit(c);
  return loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => stringify(c));
};

describe("routines config", () => {
  it("loads both kinds with their defaults", () => {
    const c = load()();
    expect(c.routines["weekly-review"]).toMatchObject({ kind: "agent", enabled: false, mcp: ["o2prod"], budget: { maxSteps: 20 } });
    expect(c.routines["daily-triage"]).toMatchObject({
      kind: "pipeline",
      enabled: true,
      mcp: [],
      delivery: { notify: "always", slack: [{ channel: "C0TEAM", lang: "zh", section: "all" }], confluence: { space: "OPS" } },
    });
    expect(c.outbox.slack.testChannel).toBe("C0TEST");
  });

  it("needs nothing new without routines", () => {
    const c = loadConfig({ ...env, NEOTAGS_CONFIG: "f" }, () => "");
    expect(c.routines).toEqual({});
    expect(c.outbox).toEqual({ slack: { allowedChannels: [] } });
  });

  it("checks routine names: the CronJob's name, at most 52", () => {
    const named = (name: string) =>
      load((c) => {
        c.routines = { [name]: pipeline() };
      });
    expect(named("Daily")).toThrow(/lowercase/);
    expect(named("1daily")).toThrow(/lowercase/);
    expect(named("a".repeat(53))).toThrow(/at most 52/);
    expect(named("daily-")).toThrow(/not ending in a dash/);
    expect(named("a")().routines).toHaveProperty("a");
    expect(named("a".repeat(52))().routines).toHaveProperty("a".repeat(52));
  });

  it("checks disabled routines in full", () => {
    expect(load((c) => (c.routines["weekly-review"].delivery.slack[0].channel = "C0OTHER"))).toThrow(/C0OTHER is not in outbox.slack.allowedChannels/);
    expect(load((c) => (c.routines["weekly-review"].trigger.schedule = "0 0 10 * * 1"))).toThrow(/6 fields/);
  });

  it("refuses schedules a CronJob does not take", () => {
    const at = (schedule: string) => load((c) => (c.routines["daily-triage"].trigger.schedule = schedule));
    expect(at("0 0 9 * * *")).toThrow(/6 fields; a CronJob schedule has 5/);
    expect(at("@daily")).toThrow(/1 fields/);
    expect(at("@every 1h")).toThrow(/2 fields/);
    expect(at("0 9 L * *")).toThrow(/field 3/);
    expect(at("0 9 * * 1#2")).toThrow(/field 5/);
    expect(at("0 9 * * 7")).toThrow(/0-6/);
    expect(at("0 9 * * 0-7")).toThrow(/0-6/);
    expect(at("0 9 * * 1-5/7")).not.toThrow();
    expect(at("0 9 * * SUN,SAT")).not.toThrow();
    expect(at("0 25 * * *")).toThrow(/schedule .*0 25 \* \* \*.*expected range 0-23/);
    expect(at("*/15 9-18 1,15 JAN-MAR mon-fri")().routines["daily-triage"]!.trigger.schedule).toBe("*/15 9-18 1,15 JAN-MAR mon-fri");
  });

  it("refuses time zones that are not IANA names", () => {
    const tz = (timeZone: string) => load((c) => (c.routines["daily-triage"].trigger.timeZone = timeZone));
    expect(tz("Mars/Olympus")).toThrow(/not an IANA time zone/);
    expect(tz("+08:00")).toThrow(/not an IANA time zone/);
    expect(tz("Local")).toThrow(/not an IANA time zone/);
    expect(tz("UTC")).not.toThrow();
    expect(tz("Etc/UTC")).not.toThrow();
    // Kubernetes reads names case-sensitively; Intl would take these.
    expect(tz("asia/shanghai")).toThrow(/did you mean Asia\/Shanghai/);
    expect(tz("utc")).toThrow(/case matters/);
    expect(load((c) => delete c.routines["daily-triage"].trigger.timeZone)).toThrow(/timeZone/);
  });

  it("refuses channels and spaces outside the outbox allowlists, the owner's too", () => {
    expect(load((c) => (c.routines["daily-triage"].owner.slack = "C0OTHER"))).toThrow(/owner.*C0OTHER is not in outbox.slack.allowedChannels/s);
    expect(load((c) => (c.routines["daily-triage"].delivery.confluence.space = "HR"))).toThrow(/space HR is not in outbox.confluence.allowedSpaces/);
    expect(load((c) => delete c.outbox.confluence)).toThrow(/Confluence delivery needs outbox.confluence/);
    expect(load((c) => (c.outbox.slack.testChannel = "C0OTHER"))).toThrow(/testChannel.*C0OTHER/s);
    expect(load((c) => delete c.outbox.slack.testChannel)).toThrow(/test channel/);
  });

  it("needs a delivery target", () => {
    expect(load((c) => (c.routines["weekly-review"].delivery = { notify: "always" }))).toThrow(/at least one target/);
  });

  it("refuses packs and MCP servers that are not configured", () => {
    expect(load((c) => (c.routines["daily-triage"].packs = ["nope"]))).toThrow(/skill pack .*nope.* is not in skillPacks.packs/);
    expect(load((c) => (c.routines["weekly-review"].mcp = ["o2"]))).toThrow(/MCP server .*o2.* is not in mcp.servers/);
  });

  it("refuses a budget above the defaults", () => {
    expect(load((c) => (c.routines["weekly-review"].budget = { wallClockSec: 901 }))).toThrow(/wallClockSec.*agent.wallClockSec.job \(900\)/s);
    expect(load((c) => (c.routines["weekly-review"].budget = { maxSteps: 31 }))).toThrow(/maxSteps.*agent.maxSteps \(30\)/s);
    expect(
      load((c) => {
        c.agent = { wallClockSec: { job: 1200 } };
        c.routines["weekly-review"].budget = { wallClockSec: 1200 };
      }),
    ).not.toThrow();
  });

  it("refuses misspelt keys instead of dropping them", () => {
    expect(load((c) => (c.routines["weekly-review"].enable = false))).toThrow(/enable/);
    expect(load((c) => (c.routines["daily-triage"].trigger.schedul = "0 9 * * *"))).toThrow(/schedul/);
    // Fields of the other kind.
    expect(load((c) => (c.routines["daily-triage"].instructions = "x"))).toThrow(/instructions/);
    expect(load((c) => (c.routines["weekly-review"].kind = "script"))).toThrow(/kind/);
  });

  it("needs the internal API, which the CronJobs call", () => {
    expect(load((c) => (c.jobsApi = { enabled: false }))).toThrow(/jobsApi is not enabled/);
  });
});

describe("routinePackIssues", () => {
  it("refuses executable packs for a pipeline's classify run, not for an agent routine", () => {
    const c = load((c) => (c.routines["weekly-review"].packs = ["classify"]))();
    const issues = routinePackIssues(c.routines, (p) => p === "classify");
    expect(issues).toEqual([expect.stringMatching(/routines.daily-triage.packs: skill pack "classify" declares sandbox/)]);
    expect(routinePackIssues(c.routines, () => false)).toEqual([]);
  });
});
