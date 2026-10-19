import type { Notifier, Task } from "../task.js";

/** Milestone 1: no skills registered yet. The LLM intent router lands with kb-collect. */
export class Router {
  constructor(
    private botName: string,
    private notifier: Notifier,
  ) {}

  async handle(task: Task): Promise<void> {
    await this.notifier.reply(
      task.reply,
      `Hi <@${task.actor.id}>, ${this.botName} is online. I don't have any skills enabled yet.`,
    );
  }
}
