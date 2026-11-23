import type { Logger } from "pino";
import type { Config } from "../config/index.js";
import { DeliveryError, type DeliveryContext, type DeliveryResult, type DeliveryTarget, type Outbox, type OwnerNotice } from "../routines/outbox.js";
import { endDeliverySpan, startDeliverySpan } from "../telemetry/spans.js";
import { loadBundle } from "./bundle.js";
import { deliverConfluence, type ConfluenceApi } from "./confluence.js";
import { deliverSlack, slackChannel, type SlackApi } from "./slack.js";

export { ConfluenceApi } from "./confluence.js";
export type { SlackApi } from "./slack.js";

// The Outbox (S-D10): delivers one target of a period from the period's bundle, through its sink (Slack, Confluence),
// each step recorded as it is done so a retry only does what is left; and sends the owner's failure notices. Which
// targets are due, the lease before each, and delivered.json are the period's (src/routines/period.ts).

export interface OutboxOptions {
  cfg: Pick<Config, "outbox" | "routines">;
  /** The bot token's Web API client. */
  slack: SlackApi;
  /** Absent (no credentials): Confluence targets fail, except on a dry run without a test parent. */
  confluence?: ConfluenceApi;
  log: Pick<Logger, "info" | "warn">;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createOutbox(o: OutboxOptions): Outbox {
  const { cfg, log } = o;
  const warn = (obj: object, msg: string) => log.warn(obj, msg);

  async function deliver(target: DeliveryTarget, ctx: DeliveryContext): Promise<DeliveryResult> {
    const sink = target.slack ? "slack" : "confluence";
    const span = startDeliverySpan(ctx.span, { name: ctx.routine, period: ctx.period, sink, target: target.key, dryRun: ctx.dryRun });
    const started = Date.now();
    const steps: string[] = [];
    const did = (s: string) => void steps.push(s);
    const fields = { routine: ctx.routine, period: ctx.period, dryRun: ctx.dryRun, target: target.key, sink };
    try {
      const routine = Object.hasOwn(cfg.routines, ctx.routine) ? cfg.routines[ctx.routine] : undefined;
      if (!routine) throw new DeliveryError("config", `unknown routine ${ctx.routine}`);
      const bundle = await loadBundle(ctx);
      let r: DeliveryResult;
      if (target.slack) r = await deliverSlack(o.slack, cfg, target.slack, bundle, ctx, did, warn);
      else if (target.confluence) r = await deliverConfluence(o.confluence, cfg, target.confluence, routine.trigger.timeZone, bundle, ctx, did, warn);
      else throw new DeliveryError("config", `target ${target.key} has no sink`);
      const durationMs = Date.now() - started;
      endDeliverySpan(span, { ok: true, steps, durationMs, ...(r.link && { link: r.link }) });
      log.info({ ...fields, outcome: "ok", steps, durationMs, ...(r.link && { link: r.link }) }, "delivery target finished");
      return r;
    } catch (err) {
      const durationMs = Date.now() - started;
      const step = err instanceof DeliveryError ? err.step : undefined;
      const reason = errText(err);
      endDeliverySpan(span, { ok: false, steps, durationMs, reason, ...(step && { step }) });
      log.warn({ ...fields, outcome: "failed", steps, durationMs, ...(step && { step }), reason }, "delivery target finished");
      throw err;
    }
  }

  async function notifyOwner(n: OwnerNotice): Promise<void> {
    const routine = Object.hasOwn(cfg.routines, n.routine) ? cfg.routines[n.routine] : undefined;
    const fields = { routine: n.routine, period: n.period, dryRun: n.dryRun, kind: n.kind };
    try {
      if (!routine) throw new Error(`unknown routine ${n.routine}`);
      const channel = slackChannel(cfg, routine.owner.slack, n.dryRun);
      const head = n.kind === "failed" ? `:x: Routine \`${n.routine}\` failed` : `:warning: Routine \`${n.routine}\` delivered without the classify run's result`;
      const text = [
        `${head}${n.dryRun ? " (dry run)" : ""}`,
        `• Period: \`${n.period}\``,
        ...(n.step ? [`• Step: \`${n.step}\``] : []),
        `• Reason: ${n.reason.slice(0, 1500)}`,
        `• Run: ${n.runIds.length ? n.runIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
      ].join("\n");
      await o.slack.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false, mrkdwn: true });
      log.info({ ...fields, channel }, "routine owner notified");
    } catch (err) {
      log.warn({ ...fields, err: errText(err) }, "could not notify the routine's owner");
    }
  }

  return { deliver, notifyOwner };
}
