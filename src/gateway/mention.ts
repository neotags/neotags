const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Remove every `<@botUserId>` mention (with optional `|label`) and tidy whitespace. */
export function stripMention(text: string, botUserId: string): string {
  const re = new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`, "g");
  return text.replace(re, " ").replace(/\s+/g, " ").replace(/^[\s,:;-]+/, "").trim();
}
