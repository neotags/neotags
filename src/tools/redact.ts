export interface RedactResult {
  text: string;
  /** Number of redactions made, reported in the summary footer. */
  count: number;
}

const MARK = "[REDACTED]";

// Ordered: specific token shapes first, then generic assignments, then entropy.
const PATTERNS: { name: string; re: RegExp; replace?: string }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  { name: "slack-token", re: /\bxox[abprso]-[A-Za-z0-9-]{10,}\b/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1${MARK}` },
  {
    // password=..., "api_key": "...", token: ... (keeps the key name so the summary stays useful)
    name: "assignment",
    re: /(?<![A-Za-z0-9])((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?[a-z_-]*["']?\s*[:=]\s*["']?)[^\s"'`,;]{6,}/gi,
    replace: `$1${MARK}`,
  },
  { name: "url-credentials", re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi, replace: `$1${MARK}$2` },
];

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Long mixed-class tokens with high entropy (random keys). Hashes and plain words stay. */
function looksRandom(tok: string): boolean {
  if (tok.length < 32) return false;
  if (/^[0-9a-f]+$/i.test(tok)) return false; // git/sha hex digests are not secrets
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(tok)).length;
  return classes >= 2 && entropy(tok) >= 4.2;
}

export function redact(input: string): RedactResult {
  let count = 0;
  let text = input;
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args) => {
      count++;
      if (!p.replace) return MARK;
      // expand $1/$2 manually so the replacement can keep captured prefixes
      return p.replace.replace(/\$(\d)/g, (_, i) => String(args[Number(i)] ?? ""));
    });
  }
  text = text.replace(/[A-Za-z0-9+/_=-]{32,}/g, (tok) => {
    if (tok === MARK || !looksRandom(tok)) return tok;
    count++;
    return MARK;
  });
  return { text, count };
}
