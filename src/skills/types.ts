import type { Logger } from "pino";
import type { LlmClient } from "../agent/llm.js";
import type { OnyxClient } from "../tools/onyx.js";
import type { SlackReader } from "../tools/slack.js";
import type { Notifier, Task } from "../task.js";

export interface SkillContext {
  notifier: Notifier;
  slack: SlackReader;
  llm: LlmClient;
  /** Undefined when Onyx is not configured; skills that need it must say so. */
  onyx?: OnyxClient;
  log: Logger;
  botName: string;
  /** Record threads from private channels (config slack.allowPrivateChannels). DMs are never recorded. */
  allowPrivateChannels: boolean;
  /** Reading files shared in Slack into the KB (config attachments.*). */
  attachments: { enabled: boolean; maxFileBytes: number; maxFiles: number; maxTextChars: number; summarize: boolean };
  /** Sections fetched from Onyx to answer one question (config onyx.maxResults). */
  maxSearchResults: number;
  /** Prompt budget for summarization, in tokens (estimated). */
  maxInputTokens: number;
}

export interface SkillAction {
  /** The part of the Slack action id after `<skill>:`. */
  id: string;
  value: string;
  actor: { id: string };
  channel: string;
}

export interface Skill {
  /** Stable id; also the Slack action-id prefix (`<name>:<action>`). */
  name: string;
  /** One line the router LLM uses to decide when this skill applies. */
  description: string;
  run(task: Task, ctx: SkillContext): Promise<void>;
  /** Handle a button click; the returned text replaces the original message. */
  onAction?(action: SkillAction, ctx: SkillContext): Promise<string>;
}
