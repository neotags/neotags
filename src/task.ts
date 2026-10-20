/** Where a task's result should be delivered. */
export interface ReplyTarget {
  kind: "slack";
  channel: string;
  /** thread to reply in; absent = top-level post */
  threadTs?: string;
}

/** Origin-agnostic unit of work; skills never see the transport. */
export interface Task {
  id: string;
  source: "slack";
  actor: { id: string };
  /** Message text with the bot mention removed. */
  text: string;
  reply: ReplyTarget;
  /** The message that triggered the task, if any (for reactions). */
  triggerTs?: string;
  /** Present when the mention was posted inside an existing thread (the thread root's ts). */
  thread?: { ts: string };
  /** True when the task came from a 1:1 DM with the bot: no mention, and no channel thread to record. */
  dm?: boolean;
}

export interface Notifier {
  /** `text` is the plain fallback; `blocks` (Slack Block Kit) carry the rich layout and buttons. */
  reply(target: ReplyTarget, text: string, blocks?: unknown[]): Promise<void>;
  react(target: ReplyTarget, ts: string, emoji: string): Promise<void>;
}
