/** Remove every `<@botUserId>` mention (with optional `|label`) and tidy whitespace. */
export function stripMention(text: string, botUserId: string): string {
  const re = new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g");
  return text.replace(re, " ").replace(/\s+/g, " ").replace(/^[\s,:;-]+/, "").trim();
}
