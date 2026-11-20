import { describe, expect, it } from "vitest";
import { formatPeriod, isScheduled, parsePeriod, periodError, periodFromJobName } from "../src/routines/schedule.js";

const minutes = (iso: string) => String(Date.parse(iso) / 60_000);

describe("periods", () => {
  it("reads the period from the name the CronJob controller gives the Job", () => {
    expect(periodFromJobName("vnet-alert-triage", `vnet-alert-triage-${minutes("2026-11-18T01:00:00Z")}`)).toBe("2026-11-18T01:00:00Z");
    // The routine name itself may end in digits.
    expect(periodFromJobName("report-2", `report-2-${minutes("2026-11-18T01:30:00Z")}`)).toBe("2026-11-18T01:30:00Z");
  });

  it("finds no period in a Job made by hand", () => {
    expect(periodFromJobName("daily", "daily-manual")).toBeUndefined();
    expect(periodFromJobName("daily", "daily-rerun-29409660")).toBeUndefined();
    expect(periodFromJobName("daily", "daily")).toBeUndefined();
    expect(periodFromJobName("daily", "other-29409660")).toBeUndefined();
    expect(periodFromJobName("daily", "daily-1234567")).toBeUndefined();
    // Past what a Date can hold: no period, not a crash.
    expect(periodFromJobName("daily", "daily-99999999999999999999")).toBeUndefined();
    expect(periodFromJobName("daily", undefined)).toBeUndefined();
  });

  it("takes a period by hand in any offset, on a whole minute", () => {
    expect(parsePeriod("2026-11-18T09:00:00+08:00")).toBe("2026-11-18T01:00:00Z");
    expect(parsePeriod("2026-11-18T01:00:00Z")).toBe("2026-11-18T01:00:00Z");
    expect(parsePeriod("2026-11-18T01:00:00.000z")).toBe("2026-11-18T01:00:00Z");
    expect(parsePeriod("2026-11-17T20:00:00-05:00")).toBe("2026-11-18T01:00:00Z");
    expect(parsePeriod("2026-11-18T01:00:30Z")).toBeUndefined();
    expect(parsePeriod("2026-11-18 01:00")).toBeUndefined();
    expect(parsePeriod("2026-02-30T01:00:00Z")).toBeUndefined();
    expect(parsePeriod("yesterday")).toBeUndefined();
  });

  it("formats an instant as its minute in UTC", () => {
    expect(formatPeriod(Date.parse("2026-11-18T01:00:59.999Z"))).toBe("2026-11-18T01:00:00Z");
  });
});

describe("isScheduled", () => {
  it("matches the schedule in the routine's time zone", () => {
    expect(isScheduled("0 9 * * *", "Asia/Shanghai", "2026-11-18T01:00:00Z")).toBe(true);
    expect(isScheduled("0 9 * * *", "Asia/Shanghai", "2026-11-18T09:00:00Z")).toBe(false);
    expect(isScheduled("0 9 * * *", "UTC", "2026-11-18T09:00:00Z")).toBe(true);
    // Monday 10:00 in Shanghai is Monday 02:00 UTC; the day of the week is the zone's too.
    expect(isScheduled("0 10 * * 1", "Asia/Shanghai", "2026-11-16T02:00:00Z")).toBe(true);
    expect(isScheduled("0 1 * * 1", "Asia/Shanghai", "2026-11-15T17:00:00Z")).toBe(true);
    expect(isScheduled("0 1 * * 1", "Asia/Shanghai", "2026-11-16T17:00:00Z")).toBe(false);
  });

  it("follows DST: the same wall-clock time is a different UTC time in summer and winter", () => {
    expect(isScheduled("0 9 * * *", "America/New_York", "2026-07-01T13:00:00Z")).toBe(true);
    expect(isScheduled("0 9 * * *", "America/New_York", "2026-12-01T14:00:00Z")).toBe(true);
    expect(isScheduled("0 9 * * *", "America/New_York", "2026-12-01T13:00:00Z")).toBe(false);
    // The day clocks go forward (2026-03-08, 02:00 -> 03:00 EDT): 09:00 EDT is 13:00 UTC.
    expect(isScheduled("0 9 * * *", "America/New_York", "2026-03-08T13:00:00Z")).toBe(true);
    expect(isScheduled("0 9 * * *", "America/New_York", "2026-03-08T14:00:00Z")).toBe(false);
  });

  it("takes both firings in the hour clocks go back, as the CronJob controller runs both", () => {
    // 2026-11-01 in New York: 01:30 EDT (05:30 UTC), then 01:30 EST (06:30 UTC).
    expect(isScheduled("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe(true);
    expect(isScheduled("30 1 * * *", "America/New_York", "2026-11-01T06:30:00Z")).toBe(true);
  });

  it("has no period in the hour clocks skip", () => {
    // 2026-03-08 02:30 does not exist in New York: 06:30 UTC is 01:30 EST, 07:30 UTC is 03:30 EDT.
    expect(isScheduled("30 2 * * *", "America/New_York", "2026-03-08T06:30:00Z")).toBe(false);
    expect(isScheduled("30 2 * * *", "America/New_York", "2026-03-08T07:30:00Z")).toBe(false);
    expect(isScheduled("30 2 * * *", "America/New_York", "2026-03-09T06:30:00Z")).toBe(true);
  });
});

describe("periodError", () => {
  const trigger = { schedule: "0 9 * * *", timeZone: "Asia/Shanghai" };
  const now = Date.parse("2026-11-18T01:05:00Z");

  it("accepts a firing of the last 8 days", () => {
    expect(periodError(trigger, "2026-11-18T01:00:00Z", now)).toBeUndefined();
    expect(periodError(trigger, "2026-11-11T01:00:00Z", now)).toBeUndefined();
  });

  it("refuses periods off the schedule, too old, in the future or not in the period format", () => {
    expect(periodError(trigger, "2026-11-17T02:00:00Z", now)).toMatch(/not a time/);
    expect(periodError(trigger, "2026-11-10T01:00:00Z", now)).toMatch(/8 days/);
    expect(periodError(trigger, "2026-11-19T01:00:00Z", now)).toMatch(/future/);
    expect(periodError(trigger, "2026-11-18T09:00:00+08:00", now)).toMatch(/not a period/);
  });
});
