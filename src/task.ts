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
}

export interface Notifier {
  reply(target: ReplyTarget, text: string): Promise<void>;
  react(target: ReplyTarget, ts: string, emoji: string): Promise<void>;
}
