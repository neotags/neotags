import { describe, expect, it } from "vitest";
import { Inflight } from "../src/gateway/inflight.js";

describe("Inflight", () => {
  it("drains once tracked work settles, including failures", async () => {
    const f = new Inflight();
    let release!: () => void;
    f.track(new Promise<void>((r) => (release = r)));
    f.track(Promise.reject(new Error("boom")).catch(() => {}));
    const drained = f.drain(1000);
    release();
    expect(await drained).toBe(true);
    expect(f.size).toBe(0);
  });

  it("reports false on timeout", async () => {
    const f = new Inflight();
    f.track(new Promise<void>(() => {}));
    expect(await f.drain(20)).toBe(false);
  });

  it("is immediately true when idle", async () => {
    expect(await new Inflight().drain(10)).toBe(true);
  });
});
