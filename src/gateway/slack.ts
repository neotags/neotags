import { App, ExpressReceiver } from "@slack/bolt";
import type { Logger } from "pino";
import type { Config } from "../config/index.js";
import { authorize } from "../guardrails/policy.js";
import type { Router } from "../router/index.js";
import { createSlackReader, type SlackReader, type SlackWebApi } from "../tools/slack.js";
import type { Notifier, ReplyTarget, Task } from "../task.js";
import { Dedupe } from "./dedupe.js";
import { Inflight } from "./inflight.js";
import { stripMention } from "./mention.js";

export interface SlackDeps {
  notifier: Notifier;
  slack: SlackReader;
}

export function createSlack(cfg: Config, log: Logger, makeRouter: (d: SlackDeps) => Router) {
  const receiver = new ExpressReceiver({
    signingSecret: cfg.secrets.slackSigningSecret,
    endpoints: "/slack/events",
  });
  receiver.router.get("/healthz", (_req, res) => void res.status(200).send("ok"));

  const app = new App({ token: cfg.secrets.slackBotToken, receiver });

  const notifier: Notifier = {
    async reply(t: ReplyTarget, text: string, blocks?: unknown[]) {
      await app.client.chat.postMessage({
        channel: t.channel,
        thread_ts: t.threadTs,
        text,
        ...(blocks && { blocks: blocks as never }),
      });
    },
    async react(t: ReplyTarget, ts: string, emoji: string) {
      await app.client.reactions.add({ channel: t.channel, timestamp: ts, name: emoji });
    },
  };
  const slack = createSlackReader(app.client as unknown as SlackWebApi);
  const router = makeRouter({ notifier, slack });
  const dedupe = new Dedupe();
  const inflight = new Inflight();

  /** Best-effort Slack call: log and swallow so one failed post never becomes an unhandled rejection. */
  const safely = async (what: string, fn: () => Promise<void>, ctx: object) => {
    try {
      await fn();
    } catch (err) {
      log.warn({ err, what, ...ctx }, "slack call failed");
    }
  };

  app.event("app_mention", async ({ event, body, context }) => {
    // Bolt acks the HTTP request itself; the work below runs after the 3s window is safe.
    const eventId = (body as { event_id?: string }).event_id ?? `${event.channel}:${event.ts}`;
    const user = event.user;
    if (!user || !context.botUserId) return;
    const botUserId = context.botUserId;
    if (dedupe.isDuplicate(eventId)) return;

    await inflight.track(
      (async () => {
        const reply: ReplyTarget = {
          kind: "slack",
          channel: event.channel,
          threadTs: event.thread_ts ?? event.ts,
        };
        const decision = authorize(
          { allowedChannels: cfg.slack.allowedChannels, allowedUsers: cfg.slack.allowedUsers },
          event.channel,
          user,
        );
        if (!decision.ok) {
          // Quiet 🚫 reaction instead of a public message: no channel noise, no hint to outsiders.
          log.info({ eventId, user, channel: event.channel, reason: decision.reason }, "denied");
          await safely("react", () => notifier.react(reply, event.ts, "no_entry_sign"), { eventId });
          return;
        }

        const task: Task = {
          id: eventId,
          source: "slack",
          actor: { id: user },
          text: stripMention(event.text, botUserId),
          reply,
          triggerTs: event.ts,
          ...(event.thread_ts && { thread: { ts: event.thread_ts } }),
        };
        log.info({ taskId: task.id, user, channel: event.channel }, "task received");
        try {
          await router.handle(task);
        } catch (err) {
          log.error({ err, taskId: task.id }, "task failed");
          // Let a retry of this event run again instead of dropping it as a duplicate.
          dedupe.forget(eventId);
          await safely(
            "reply",
            () => notifier.reply(reply, "Something went wrong handling that. It has been logged."),
            { eventId },
          );
        }
      })(),
    );
  });

  // Button clicks (e.g. Undo). Action ids are `<skill>:<action>`; the same allowlists apply.
  app.action(/^[a-z][a-z0-9-]*:[a-z0-9_-]+$/i, async ({ ack, action, body, respond }) => {
    await ack();
    const value = (action as { value?: string }).value ?? "";
    const actionId = (action as { action_id: string }).action_id;
    const channel = (body as { channel?: { id?: string } }).channel?.id;
    const user = body.user.id;
    if (!channel) return;
    const decision = authorize(
      { allowedChannels: cfg.slack.allowedChannels, allowedUsers: cfg.slack.allowedUsers },
      channel,
      user,
    );
    if (!decision.ok) {
      await safely("respond", () => respond({ response_type: "ephemeral", replace_original: false, text: `Sorry, ${decision.reason}.` }).then(() => {}), { actionId });
      return;
    }
    await inflight.track(
      (async () => {
        try {
          const text = await router.handleAction(actionId, value, { id: user }, channel);
          if (text) await safely("respond", () => respond({ replace_original: true, text }).then(() => {}), { actionId });
        } catch (err) {
          log.error({ err, actionId }, "action failed");
          await safely("respond", () => respond({ response_type: "ephemeral", replace_original: false, text: "That didn't work. It has been logged." }).then(() => {}), { actionId });
        }
      })(),
    );
  });

  return { app, drain: (timeoutMs: number) => inflight.drain(timeoutMs) };
}
