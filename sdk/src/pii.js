/**
 * Minimal regex-based PII scrubber.
 *
 * Not exhaustive — designed to demonstrate the layer in the pipeline.
 * In production you'd reach for a maintained library (Microsoft Presidio,
 * Google DLP, etc.) or a small classifier model. The interface here is
 * intentionally `(string) -> string` so swapping is trivial.
 */

const PATTERNS = [
  // Emails
  { name: 'EMAIL',    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  // Phone numbers (loose international)
  { name: 'PHONE',    re: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // Credit card-ish 13-19 digit runs
  { name: 'CC',       re: /\b(?:\d[ -]*?){13,19}\b/g },
  // US SSN
  { name: 'SSN',      re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // IPv4
  { name: 'IP',       re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // Anthropic / OpenAI style API keys
  { name: 'API_KEY',  re: /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/g }
];

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

export function redactMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(m => ({ ...m, content: redact(m.content) }));
}
