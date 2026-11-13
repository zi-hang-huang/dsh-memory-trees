/**
 * v3 subject extractor: derive the "what is this about" key for an LTM record.
 *
 * Why this exists (promote-plan §10, "the blank step 6 cannot dodge"): `toLtmRecord`
 * accepts a `subject` from its caller but nothing in the codebase ever produces one.
 * Without it, `supersedes` never fires (two values of the same fact stay as two
 * unrelated records) and v4's graph expansion only has the "same source session"
 * fallback. This module fills that hole — a pure, dependency-free, rule-based version.
 *
 * Design constraints (promote-plan §3.1 "A: explicit subject key"):
 *   - **Rule-based, zero-dependency.** No tokenizer, no embedding (explicitly out of
 *     scope, plan §1.2). A regex normaliser is enough and it is deterministic/testable.
 *   - **Conservative: return null when unsure.** A record with `subject: null` can
 *     never supersede or be superseded (toLtmRecord defaults those off when subject is
 *     null). Recording the wrong subject is worse than recording none — it would merge
 *     two *different* facts. So the extractor only claims a subject when the title has
 *     a clear "config-key" or "verbatim-quoted short key" shape.
 *   - **Same input → same output.** Pure string transform, no clock, no randomness.
 *
 * What it recognises (see `extractSubject`):
 *   1. Config-style identifiers in title/body: `Config.RetainTokens` /
 *      `config.retain_tokens` / `retainTokens` — camelCase, snake_case, dotted paths.
 *      Normalised to the dotted lowercase form (`config.retaintokens`) so the same
 *      parameter spelled three ways yields one key.
 *   2. An explicitly quoted key in the title: `「保留窗口」` / `"barrierPolicy"` — a short
 *      (<= 24 char) quoted span at the very start of the title or immediately before a
 *      colon is taken as the subject.
 *   3. Otherwise: null. (A generic Chinese/English prose title does NOT get a subject —
 *      that would be guessing, and the plan says guess-not.)
 *
 * @module dsh-memory/subject
 */

/** Max characters for a quoted-key subject; longer quotes are prose, not a key. */
const MAX_SUBJECT_CHARS = 40;

/** Regex for config-style identifiers we treat as subject keys. */
// Matches `Foo.Bar`, `foo.bar_baz`, `someCamelCase` (>=2 words) but NOT a lone
// capitalised English word ("Retry") or a lowercase sentence word ("the").
const DOTTED_IDENT = /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9_]*)+/;
const CAMEL_IDENT = /\b[a-z]+(?:[A-Z][a-z0-9]+){1,}\b/; // e.g. retainTokens, barrierPolicy
const SNAKE_IDENT = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/; // e.g. retain_tokens

/** Quoted span at title start or just before a colon: 「...」 “...” "..." ‘...’ '...'. */
const LEADING_QUOTED = /^[\s\u3000]*[「『“"‘']([^」』”"’']{1,24})[」』”"’'][\s\u3000]*[:：]/;
const COLON_QUOTED = /[:：][\s\u3000]*[「『“"‘']([^」』”"’']{1,24})[」』”"’'][\s\u3000]*$/;

/**
 * Normalise one config-style identifier to a stable lowercase key.
 * `Config.RetainTokens` → `config.retaintokens`; `retain_tokens` → `retain_tokens`.
 * Dots are preserved as separators; underscores are preserved as-is. Case folds.
 * @param {string} raw - matched identifier text.
 * @returns {string} normalised key.
 */
function normaliseIdent(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/**
 * Normalise a quoted-key subject: trim, collapse internal whitespace to one space,
 * fold case. We keep the words (they are the human's own query terms, plan §9 "subject
 * is the user's most likely query word") but make matching case-insensitive.
 * @param {string} raw - captured quoted span.
 * @returns {string|null} normalised subject or null when empty.
 */
function normaliseQuoted(raw) {
  const s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (s === "") return null;
  return s.slice(0, MAX_SUBJECT_CHARS);
}

/**
 * Extract a subject key for a session node.
 *
 * Priority (first that yields a non-empty key wins):
 *   1. A quoted short key at the title's head or immediately before a trailing colon
 *      (`「保留窗口」: …`). The human's own term, highest precision.
 *   2. A config-style identifier (dotted / camelCase / snake_case) in the title.
 *   3. A config-style identifier in the first 200 chars of the body (titles are terse;
 *      a decision often names the parameter it changes in the body).
 *   4. null — do not guess.
 *
 * @param {{title?: string, body?: string}} node - session node.
 * @returns {string|null} normalised subject, or null when no confident key exists.
 */
export function extractSubject(node) {
  const title = String(node?.title ?? "");
  const body = String(node?.body ?? "");

  // 1. Explicitly quoted key (highest precision — the author already named it).
  const lead = LEADING_QUOTED.exec(title);
  if (lead) {
    const s = normaliseQuoted(lead[1]);
    if (s !== null) return s;
  }
  const tail = COLON_QUOTED.exec(title);
  if (tail) {
    const s = normaliseQuoted(tail[1]);
    if (s !== null) return s;
  }

  // 2. Config-style identifier in the title.
  const titleIdent =
    DOTTED_IDENT.exec(title) ?? CAMEL_IDENT.exec(title) ?? SNAKE_IDENT.exec(title);
  if (titleIdent) return normaliseIdent(titleIdent[0]);

  // 3. Config-style identifier near the head of the body.
  const bodyHead = body.slice(0, 200);
  const bodyIdent =
    DOTTED_IDENT.exec(bodyHead) ?? CAMEL_IDENT.exec(bodyHead) ?? SNAKE_IDENT.exec(bodyHead);
  if (bodyIdent) return normaliseIdent(bodyIdent[0]);

  // 4. Not confident — the record can still be stored, it just never supersedes.
  return null;
}

export default extractSubject;
