import type { ArtifactStore } from "../artifacts/index.js";
import type { Routine } from "../config/index.js";

// Delivery of a period's result. The engine decides which targets are due and records each outcome in
// delivered.json; an Outbox only delivers one target. Until there is one (S03), a period ends with a
// delivery-pending.json listing what it would have delivered, and counts as delivered.

type Delivery = Routine["delivery"];

export interface DeliveryTarget {
  /** Stable across holders and retries: delivered.json is keyed by it. From the configuration, never the dry run's. */
  key: string;
  slack?: Delivery["slack"][number];
  confluence?: NonNullable<Delivery["confluence"]>;
}

/** The configured targets, or none when the routine posts only with findings and the result has none. */
export function deliveryTargets(delivery: Delivery, notify: boolean): DeliveryTarget[] {
  if (delivery.notify === "when_findings" && !notify) return [];
  return [
    ...delivery.slack.map((t) => ({ key: `slack:${t.channel}:${t.section}:${t.lang}`, slack: t })),
    ...(delivery.confluence ? [{ key: `confluence:${delivery.confluence.space}:${delivery.confluence.parent}`, confluence: delivery.confluence }] : []),
  ];
}

export interface DeliveryContext {
  routine: string;
  period: string;
  kind: Routine["kind"];
  /** Dry run: every Slack target is outbox.slack.testChannel, Confluence outbox.confluence.testParent (or skipped). */
  dryRun: boolean;
  /** The period's directory: a pipeline's bundle is under bundle/ (manifest.json), an agent's result is output.json. */
  dir: string;
  store: ArtifactStore;
  /** Aborted when the period must stop (lease lost, deadline, shutdown). */
  signal: AbortSignal;
}

export interface DeliveryResult {
  link?: string;
  /** Per step of the target (message, attachments, page), for delivered.json. */
  detail?: unknown;
}

export interface Outbox {
  /** Deliver one target; throws when it failed. The lease was confirmed just before. */
  deliver(target: DeliveryTarget, ctx: DeliveryContext): Promise<DeliveryResult>;
}
