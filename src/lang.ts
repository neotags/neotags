/** Language of an answer: Chinese or English, nothing else (D13). */
export type AnswerLang = "zh" | "en";

// Han ideographs only: CJK punctuation (。，、「」) and full-width forms are not Chinese characters.
const HAN = /\p{Script=Han}/u;

/**
 * The answer language for one question, by the rule every entry shares: Chinese when the current question has at
 * least one Chinese character, else English. Only the current question counts, never earlier turns, page context
 * or tool output. Text written by code (degraded answers, budget and error notices) uses this; the model gets the
 * same rule as {@link LANGUAGE_RULE}.
 */
export function answerLang(question: string): AnswerLang {
  return HAN.test(question) ? "zh" : "en";
}

/** The same rule for the model, in the system prompt of every entry. */
export const LANGUAGE_RULE = [
  "Language: if the user's current question contains at least one Chinese character, answer in Chinese; if it contains",
  "none, answer in English. Only the current question decides: not earlier turns, the page context or tool results, and",
  "punctuation alone is not a Chinese character. Keep SQL, PromQL, field names and identifiers as they are.",
].join(" ");
