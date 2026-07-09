// Secret redaction: replaces credential-shaped values in source text with a
// `[REDACTED:<kind>]` placeholder before that source is sent to a user's LLM
// provider (authoritative pattern list: rsv2-task-3b-brief.md). Patterns are
// applied in a fixed priority order (most specific credential shapes first,
// the generic key=value catch-all last) so a more specific kind (e.g.
// "anthropic") always wins over "generic" when both would otherwise match
// the same text - see the ALREADY_REDACTED guard below for why this matters
// even within a single call (e.g. `apiKey = "sk-ant-..."` is both an
// anthropic-shaped value AND a generic key=value assignment).

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

interface SimpleRule {
  kind: string;
  regex: RegExp;
}

// Order matters: applied top to bottom. Each rule replaces its ENTIRE match
// with the placeholder (unlike the generic rule below, which replaces only
// the captured value and keeps the surrounding key/delimiter/quotes intact).
// Rebuilt fresh on every call (rather than shared module-level regex
// literals) so there is no possibility of stateful `lastIndex` bleed between
// invocations - defensive, since this file's correctness is security
// sensitive.
function buildSimpleRules(): SimpleRule[] {
  return [
    {
      kind: "pem",
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    },
    { kind: "anthropic", regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
    {
      kind: "openai",
      regex: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{32,}/g,
    },
    { kind: "stripe", regex: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
    { kind: "google", regex: /AIza[0-9A-Za-z_-]{35}/g },
    { kind: "aws", regex: /AKIA[0-9A-Z]{16}/g },
    { kind: "github", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
    { kind: "slack", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
    {
      kind: "jwt",
      regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    },
  ];
}

// Key name (case-insensitive), delimiter (":"/"=" with optional surrounding
// whitespace), and a quoted value of 12+ non-quote/newline characters. Each
// piece is captured separately so the replacer can rebuild the text with
// only the value swapped out - "keep key and delimiter" per spec.
function buildGenericRule(): RegExp {
  return /(api[_-]?key|apikey|secret|token|passwd|password|client[_-]?secret)(\s*[:=]\s*)(["'])([^"'\n]{12,})(["'])/gi;
}

// Recognizes a value that is already a `[REDACTED:<kind>]` placeholder. This
// is what makes redaction idempotent: without it, a value like
// `apiKey = "sk-ant-..."` would be redacted once by the "anthropic" rule
// (to `apiKey = "[REDACTED:anthropic]"`) and then AGAIN by the generic rule
// on the very same call, since "[REDACTED:anthropic]" is itself a 12+ char
// quoted value sitting right after a recognized key name - which would both
// double-count it and clobber the more specific "anthropic" label with
// "generic". The same guard makes a wholly separate second call a true no-op.
const ALREADY_REDACTED = /^\[REDACTED:[A-Za-z0-9_]+\]$/;

/**
 * Redacts credential-shaped values from `source`, replacing each with
 * `[REDACTED:<kind>]`. Patterns are applied in priority order (see
 * buildSimpleRules); idempotent - re-running on already-redacted text yields
 * `redactedCount: 0` and byte-identical text.
 */
export function redactSecrets(source: string): RedactionResult {
  let text = source;
  let redactedCount = 0;

  for (const { kind, regex } of buildSimpleRules()) {
    text = text.replace(regex, () => {
      redactedCount++;
      return `[REDACTED:${kind}]`;
    });
  }

  text = text.replace(
    buildGenericRule(),
    (full: string, key: string, delim: string, openQuote: string, value: string, closeQuote: string) => {
      if (ALREADY_REDACTED.test(value)) return full;
      redactedCount++;
      return `${key}${delim}${openQuote}[REDACTED:generic]${closeQuote}`;
    }
  );

  return { text, redactedCount };
}
