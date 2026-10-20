import { createKbAsk } from "./kb-ask/index.js";
import { createKbCollect } from "./kb-collect/index.js";
import { createKbFiles } from "./kb-files/index.js";
import type { Skill } from "./types.js";

/** Every skill the bot ships with, in the order the router lists them. */
export const allSkills = (): Skill[] => [createKbCollect(), createKbFiles(), createKbAsk()];

/**
 * The skills left after `skills.disabled`. A disabled skill is not registered at all, so the router
 * neither offers nor runs it, and its button actions stop working. A name that matches no skill is a
 * configuration mistake (a typo would leave the skill running), so it fails at startup.
 */
export function selectSkills(all: Skill[], disabled: string[]): Skill[] {
  const unknown = disabled.filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) {
    throw new Error(`skills.disabled names unknown skill(s): ${unknown.join(", ")} (known: ${all.map((s) => s.name).join(", ")})`);
  }
  return all.filter((s) => !disabled.includes(s.name));
}
