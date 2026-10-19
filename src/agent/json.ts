import type { ZodType } from "zod";

/**
 * Pull a JSON object out of an LLM reply: the bare reply, a leading ```json fence, or the outermost braces
 * in prose. Order matters: string values may themselves contain ``` fences, so never trust the first fence.
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t];
  const lead = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(t);
  if (lead?.[1]) candidates.push(lead[1]);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(t.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no JSON object in reply");
}

export function parseWith<T>(schema: ZodType<T>, text: string): T {
  const r = schema.safeParse(extractJson(text));
  if (!r.success) throw new Error(`reply does not match the schema: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}
