import type { Span } from "@opentelemetry/api";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Routine } from "../config/index.js";
import type { DeliveredTarget } from "./records.js";

// Delivery of a period's result. The engine decides which targets are due and records each outcome in
// delivered.json; an Outbox (src/outbox/) only delivers one target. Without one, a period ends with a
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
  /** The period's root span: each target's `deliver <sink>` span hangs under it. */
  span: Span;
  /** The period's runs (the classify run, an agent routine's run), for the message's footer. */
  runIds: string[];
  /**
   * What delivered.json has for this target from an earlier attempt that did not finish (a message posted, its
   * files not all uploaded): the target goes on from its `detail` instead of starting over.
   */
  previous?: DeliveredTarget;
  /** Before each step's side effect: throws when the period must stop; renews a lease about to expire. */
  confirm(): Promise<void>;
  /** Record the target's steps so far in delivered.json (not delivered yet), right after each side effect. */
  progress(detail: unknown): Promise<void>;
}

export interface DeliveryResult {
  link?: string;
  /** Per step of the target (message, attachments, page), for delivered.json. */
  detail?: unknown;
}

/** A target failed at `step`; `detail` is what it got done before, for the next attempt. */
export class DeliveryError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** Sent to the routine's owner.slack (the test channel on a dry run) when a period fails or is degraded. */
export interface OwnerNotice {
  routine: string;
  period: string;
  dryRun: boolean;
  /** failed: the period did not deliver; degraded: it delivered without the classify run's problems. */
  kind: "failed" | "degraded";
  /** The step it failed at (a pipeline step, classify, run, deliver). */
  step?: string;
  reason: string;
  runIds: string[];
}

export interface Outbox {
  /** Deliver one target; throws when it failed (a DeliveryError names the step). The lease was confirmed just before. */
  deliver(target: DeliveryTarget, ctx: DeliveryContext): Promise<DeliveryResult>;
  /** A notice to the routine's owner; never throws (a notice that cannot be sent is logged). */
  notifyOwner(notice: OwnerNotice): Promise<void>;
}
