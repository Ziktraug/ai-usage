import {
  MAX_SKILL_OBSERVATION_PATH_LENGTH,
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  parseSkillObservation,
  type SkillObservation,
  type SkillObservationExtraction,
} from '@ai-usage/report-core/skill-observation';

/**
 * Codex has no skill tool. Two entirely different signals exist in its
 * rollouts, and ADR 0022 forbids conflating them, so this module exposes two
 * extractors that never share a code path and never share a tier:
 *
 * - {@link extractCodexSkillCatalogue} reads the `### Available skills` block
 *   that Codex injects into a session's instructions. It records what was
 *   offered to the model — the `exposed` tier — and is high confidence about
 *   exposure and silent about use.
 * - {@link extractCodexSkillExecObservation} matches an `exec` command that
 *   reads a `SKILL.md`. It is a heuristic over a shell string — the `inferred`
 *   tier — and must never be presented as equivalent to a declared call.
 *
 * They are deliberately not merged into one function. A caller that wants both
 * calls both and keeps the results apart.
 */

/** The heading Codex writes above its per-session skill catalogue. */
export const CODEX_AVAILABLE_SKILLS_HEADING = '### Available skills';

/**
 * Testing override for the per-session observation ceiling, mirroring the
 * OpenCode read-budget seam. The production ceiling guards a corrupt session
 * rather than ordinary volume, so exercising the bound honestly would mean
 * building 4096 entries; lowering it keeps the test about the behaviour —
 * detect the bound, flag it, carry the flag to the warning channel.
 */
let codexSkillCeilingOverride: number | null = null;

export const setCodexSkillObservationCeilingForTesting = (ceiling: number | null): void => {
  if (ceiling !== null && !(Number.isSafeInteger(ceiling) && ceiling > 0)) {
    throw new Error('Codex skill observation ceiling override must be a positive safe integer or null');
  }
  codexSkillCeilingOverride = ceiling;
};

export const codexSkillObservationCeiling = (): number =>
  codexSkillCeilingOverride ?? MAX_SKILL_OBSERVATIONS_PER_SESSION;

/**
 * `- <name>: <description> (file: <path>)` — the catalogue entry format.
 * The description is skipped entirely: it is prompt prose and never persisted.
 *
 * Plugin skills are namespaced (`vercel:nextjs`), so the name accepts embedded
 * colons. The separator is disambiguated by requiring the description to follow
 * whitespace: a colon inside prose (`Use when x:y`) cannot extend the name
 * because its next segment does not match the name charset.
 */
const CODEX_SKILL_NAME_SEGMENT = '[A-Za-z0-9][\\w.-]*';
const CODEX_CATALOGUE_ENTRY = new RegExp(
  `^[ \\t]*-[ \\t]+(${CODEX_SKILL_NAME_SEGMENT}(?::${CODEX_SKILL_NAME_SEGMENT})*)[ \\t]*:[ \\t]+(.*)$`,
);
const CODEX_CATALOGUE_LOCATION = /\((?:file|path):[ \t]*([^)]+)\)[ \t]*$/;
const CODEX_CATALOGUE_SECTION_BREAK = /^#{1,6}[ \t]/;

/**
 * A whole shell token naming a skill document, anchored at both ends.
 *
 * Anchoring is the point. An unanchored scan over a command blob captures
 * whatever non-space bytes precede the path — measured at 21% of real matches,
 * up to 39 characters of JSON and command fragments — which both fabricates
 * unresolved paths and persists command text this module promises never to
 * retain. Matching is therefore done against already-tokenized shell words.
 */
const CODEX_SKILL_DOCUMENT_TOKEN = new RegExp(
  `^(?:~|\\.{1,2})?(?:/[\\w.:@+-]+)*/skills/(${CODEX_SKILL_NAME_SEGMENT}(?::${CODEX_SKILL_NAME_SEGMENT})*)/SKILL\\.md$`,
);

/**
 * Commands whose verb reads a file. The `inferred` tier claims the model *read*
 * a skill, so a command that deletes or moves a SKILL.md is not evidence of use
 * — counting `rm .../SKILL.md` as an invocation would be simply false.
 * Derived from the verbs actually observed in real Codex history.
 */
const CODEX_READ_VERBS: ReadonlySet<string> = new Set([
  'bat',
  'cat',
  'head',
  'less',
  'more',
  'nl',
  'tail',
  'view',
  'wc',
]);

/**
 * Read verbs whose *first* non-flag operand is a pattern or a script rather
 * than a file: `rg …/SKILL.md transcript.txt` searches for the path, it does
 * not read it, while `rg needle …/SKILL.md` does. Treating both alike is how a
 * search over a transcript became an inferred invocation.
 */
const CODEX_SCRIPTED_READ_VERBS: ReadonlySet<string> = new Set(['awk', 'grep', 'rg', 'sed']);

/**
 * A redirect operator, optionally with its target attached (`>out`, `2>>log`).
 * A token in target position is being *written*, so `cat README.md >
 * …/SKILL.md` overwrites a skill rather than reading one.
 */
const REDIRECT_OPERATOR = /^\d*>>?/;

const isFlag = (token: string): boolean => token.startsWith('-') && token.length > 1;

/**
 * Flags that consume the following token as their value.
 *
 * Without this, the value is counted as a positional operand and every later
 * operand shifts by one: `rg --glob "*.md" …/SKILL.md transcript.txt` put the
 * skill path in what the matcher read as file position, turning a search over a
 * transcript into an inferred invocation. Only the scripted verbs need this —
 * the plain readers take no valued flags that matter here.
 */
interface CodexVerbFlags {
  /** Long flags known to take a separate value. */
  readonly long: ReadonlySet<string>;
  /** Single letters that take a value, whether glued or as the next token. */
  readonly short: ReadonlySet<string>;
}

const CODEX_VALUED_FLAGS: ReadonlyMap<string, CodexVerbFlags> = new Map([
  [
    'rg',
    {
      long: new Set([
        '--after-context',
        '--before-context',
        '--context',
        '--file',
        '--glob',
        '--iglob',
        '--max-columns',
        '--max-count',
        '--max-depth',
        '--regexp',
        '--replace',
        '--type',
        '--type-not',
      ]),
      short: new Set(['A', 'B', 'C', 'M', 'T', 'e', 'f', 'g', 'm', 'r', 't']),
    },
  ],
  [
    'grep',
    {
      long: new Set([
        '--after-context',
        '--before-context',
        '--context',
        '--devices',
        '--directories',
        '--exclude',
        '--exclude-dir',
        '--file',
        '--include',
        '--max-count',
        '--regexp',
      ]),
      short: new Set(['A', 'B', 'C', 'D', 'd', 'e', 'f', 'm']),
    },
  ],
  ['sed', { long: new Set(['--expression', '--file', '--line-length']), short: new Set(['e', 'f', 'l']) }],
  ['awk', { long: new Set(['--assign', '--field-separator', '--file']), short: new Set(['F', 'f', 'v']) }],
]);

/**
 * Flags that supply the pattern or script themselves. When one is present the
 * first positional operand is already a file, so skipping it as "the pattern"
 * would lose a real read: `grep -e needle …/SKILL.md` and its glued form
 * `grep -eneedle …/SKILL.md` both read the skill.
 */
const CODEX_PATTERN_SUPPLYING_LONG: ReadonlySet<string> = new Set(['--expression', '--file', '--regexp']);
const CODEX_PATTERN_SUPPLYING_SHORT: ReadonlySet<string> = new Set(['e', 'f']);

/**
 * `sed` in-place mode. The suffix is attached rather than a separate token
 * (`-i`, `-i.bak`), and it may sit in a short-flag cluster (`-ni`). In-place
 * mode rewrites the file and shows the model nothing, so it is a write however
 * much it looks like the read form.
 */
const SED_IN_PLACE = /^(?:-[a-zA-Z]*i|--in-place)/;

interface ParsedFlag {
  /** The flag carries the pattern or script, so the first operand is a file. */
  suppliesPattern: boolean;
  /** The flag consumes the next whole token as its value. */
  takesNextToken: boolean;
}

/**
 * Interpret one flag token under real short-cluster and attached-value rules.
 *
 * Short flags cluster (`-nm 1` is `-n -m 1`) and glue their values
 * (`-eneedle`), and getting either wrong shifts operand positions — which is
 * how a pattern ended up read as a file, and a file as a pattern.
 *
 * **Unknown long flags on a scripted verb consume the next token.** Their arity
 * cannot be known, and of the two safe choices this one is strictly the less
 * lossy: a swallowed token leaves operand position entirely, so the rule can
 * only ever *remove* a candidate read, never invent one. The cost is that a
 * boolean long flag (`rg --hidden needle …/SKILL.md`) swallows the pattern and
 * the real file then reads as the pattern — an under-count, which is the
 * direction an inferred tier should err.
 */
const parseFlagToken = (token: string, valuedFlags: CodexVerbFlags | undefined, scripted: boolean): ParsedFlag => {
  if (token.startsWith('--')) {
    const separator = token.indexOf('=');
    const name = separator < 0 ? token : token.slice(0, separator);
    const suppliesPattern = CODEX_PATTERN_SUPPLYING_LONG.has(name);
    if (separator >= 0) {
      return { suppliesPattern, takesNextToken: false };
    }
    const known = valuedFlags?.long.has(name) === true;
    return { suppliesPattern, takesNextToken: known || scripted };
  }
  // A short cluster is read left to right; the first letter that takes a value
  // claims the rest of the token, or the next token when nothing is glued.
  const letters = token.slice(1);
  for (const [index, letter] of [...letters].entries()) {
    const suppliesPattern = CODEX_PATTERN_SUPPLYING_SHORT.has(letter);
    if (valuedFlags?.short.has(letter) === true) {
      return { suppliesPattern, takesNextToken: index === letters.length - 1 };
    }
    if (suppliesPattern) {
      return { suppliesPattern: true, takesNextToken: false };
    }
  }
  return { suppliesPattern: false, takesNextToken: false };
};

/** Shell words, with one level of quoting removed. */
const SHELL_TOKEN = /'[^']*'|"[^"]*"|\S+/g;
const WHITESPACE = /\s/;

export interface CodexSkillObservationContext {
  observedAt: string;
  projectPath: string | null;
  sessionId: string;
}

export interface CodexSkillCatalogueEntry {
  name: string;
  path: string | null;
}

const boundedPath = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_SKILL_OBSERVATION_PATH_LENGTH ? normalized : null;
};

const SKILL_DOCUMENT_SUFFIX = /\/SKILL\.md$/;

/**
 * `resolvedPath` means the same thing for every harness: the skill's directory.
 * Claude Code and OpenCode disclose it directly; Codex names the document, so
 * the document suffix is trimmed here rather than leaving a field that means a
 * directory for two harnesses and a file for the third.
 */
export const codexSkillDirectory = (documentPath: string): string | null =>
  boundedPath(documentPath.replace(SKILL_DOCUMENT_SUFFIX, ''));

/**
 * Parse the catalogue block out of an instructions blob. Pure and bounded: the
 * scan stops at the next heading, and one entry past the per-session ceiling.
 *
 * Stopping *one past* is deliberate and matches the OpenCode read budget: a
 * scan that stopped exactly at the ceiling returns a full-looking list that no
 * caller can distinguish from a complete one, so the bound could never be
 * reported. The caller slices to the ceiling and treats the extra entry as the
 * truncation signal.
 *
 * A malformed or absent block yields an empty list rather than an error — the
 * catalogue is prompt text, not a contract, and its disappearance is a coverage
 * gap to be surfaced, not a collection failure.
 */
export const extractCodexSkillCatalogue = (instructions: unknown): CodexSkillCatalogueEntry[] => {
  if (typeof instructions !== 'string') {
    return [];
  }
  const headingIndex = instructions.indexOf(CODEX_AVAILABLE_SKILLS_HEADING);
  if (headingIndex < 0) {
    return [];
  }
  const entries: CodexSkillCatalogueEntry[] = [];
  const seen = new Set<string>();
  const lines = instructions.slice(headingIndex + CODEX_AVAILABLE_SKILLS_HEADING.length).split('\n');
  for (const line of lines) {
    if (entries.length > codexSkillObservationCeiling()) {
      break;
    }
    if (CODEX_CATALOGUE_SECTION_BREAK.test(line)) {
      break;
    }
    const matched = CODEX_CATALOGUE_ENTRY.exec(line);
    if (!matched?.[1]) {
      continue;
    }
    const name = matched[1];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const location = CODEX_CATALOGUE_LOCATION.exec(matched[2] ?? '');
    entries.push({ name, path: location?.[1] ? codexSkillDirectory(location[1].trim()) : null });
  }
  return entries;
};

/**
 * Project a parsed catalogue into `exposed` observations. One per skill offered
 * in the session — never a claim that any of them ran.
 */
export const codexSkillCatalogueObservations = (
  entries: readonly CodexSkillCatalogueEntry[],
  context: CodexSkillObservationContext,
): SkillObservationExtraction => {
  const observations: SkillObservation[] = [];
  let rejected = 0;
  for (const entry of entries) {
    const observation = parseSkillObservation({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: `catalogue:${entry.name}`,
      observedAt: context.observedAt,
      projectPath: context.projectPath,
      resolvedPath: entry.path,
      sessionId: context.sessionId,
      skillName: entry.name,
      // Exposure says nothing about outcome; a `false` here would read as a
      // failed invocation that never happened.
      success: null,
      tier: 'exposed',
    });
    if (observation) {
      observations.push(observation);
    } else {
      rejected += 1;
    }
  }
  return { observations, rejected, truncated: false };
};

/**
 * Match an `exec`-style command that reads a skill document and project it to
 * an `inferred` observation.
 *
 * This is a heuristic over a shell string: the command is evidence that the
 * model opened a `SKILL.md`, not that the harness dispatched a skill. The
 * command text itself is never retained — only the skill name and the document
 * path it names.
 *
 * `callId` makes re-import idempotent; without one the caller supplies a
 * record ordinal so a re-scan does not duplicate.
 */
export const extractCodexSkillExecObservation = (
  command: unknown,
  callId: string,
  context: CodexSkillObservationContext,
): SkillObservationExtraction => codexSkillExecObservations(matchCodexSkillDocuments(command), callId, context);

/**
 * Recover the shell command out of a Codex tool-call payload.
 *
 * Production never hands us a bare shell string. The two shapes that carry a
 * `SKILL.md` in real history are:
 *
 * - `function_call` / `exec_command`, whose `arguments` is JSON:
 *   `{"cmd":"sed -n '1,220p' /…/SKILL.md","workdir":"…"}`
 * - `custom_tool_call` / `exec`, whose `input` is a JavaScript snippet:
 *   `const r = await tools.exec_command({"cmd":"…"}); text(r.output);`
 *
 * plus the classic `{"command":["cat","/…/SKILL.md"]}` array form. Feeding any
 * of these to a path matcher raw is what produced the junk-prefixed paths this
 * function exists to prevent, so the command is decoded first and matched
 * second. Returns `null` when no command can be recovered — never a guess.
 */
export const decodeCodexCommand = (blob: unknown): string | null => decodeCodexCommands(blob)[0] ?? null;

/** The marker a snippet uses to invoke the shell, so a key can be tied to its call. */
const CODEX_EXEC_CALL_MARKER = 'exec_command(';

/**
 * Every command a payload actually executes.
 *
 * A snippet may contain more than one `exec_command(...)` call, and may contain
 * the string `cmd` in places that are not one — a local variable, a comment, a
 * string being logged. A key therefore counts only when it sits inside the
 * argument list of an actual call, bounded by that call's own balanced closing
 * paren. Scanning "from this call to the next one" is not enough: with a single
 * call, that window runs to the end of the blob and swallows everything after
 * it.
 *
 * There is deliberately no whole-blob fallback once a call marker exists. A
 * `cmd` outside every call is not a command this payload ran, and guessing
 * otherwise is what let a decoy key be attributed to an unrelated exec.
 */
export const decodeCodexCommands = (blob: unknown): string[] => {
  if (typeof blob !== 'string' || blob.length === 0) {
    return [];
  }
  const parsed = safeJsonObject(blob);
  if (parsed) {
    if (typeof parsed.cmd === 'string') {
      return [parsed.cmd];
    }
    if (typeof parsed.command === 'string') {
      return [parsed.command];
    }
    if (Array.isArray(parsed.command)) {
      const words = parsed.command.filter((word): word is string => typeof word === 'string');
      return words.length > 0 ? [words.join(' ')] : [];
    }
    return [];
  }
  const commands: string[] = [];
  for (const { end, start } of codexExecCallWindows(blob)) {
    const command =
      jsonStringValueForKey(blob, 'cmd', start, end) ?? jsonStringValueForKey(blob, 'command', start, end);
    if (command !== null) {
      commands.push(command);
    }
  }
  // A blob with no well-formed call yields nothing. Measured over the real
  // corpus, every SKILL.md-bearing exec payload is either a JSON object or a
  // snippet carrying a marker, and no observation came from a fallback — so
  // there is nothing to lose and a whole class of false positives (prose,
  // patch bodies, quoted commands) to close.
  return commands;
};

const WORD_CHARACTER = /[\w$]/;

/**
 * The argument windows of the `exec_command(` calls a snippet actually makes.
 *
 * Scanned in one quote-aware pass, which is what makes two whole families of
 * false attribution impossible rather than merely unlikely:
 *
 * - a marker *inside a string literal* is not a call, so a command that merely
 *   mentions `exec_command(` cannot open a window;
 * - an *unbalanced* call yields no window at all. Returning end-of-blob there
 *   would re-widen the window over everything that follows, which is the exact
 *   hole the balanced bound was introduced to close. A malformed call is
 *   dropped, so the count is a lower bound rather than a wrong one.
 */
const codexExecCallWindows = (blob: string): { end: number; start: number }[] => {
  const windows: { end: number; start: number }[] = [];
  let quote: string | null = null;
  for (let index = 0; index < blob.length; index += 1) {
    const character = blob[index];
    if (quote !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character !== '(') {
      continue;
    }
    const markerStart = index - CODEX_EXEC_CALL_MARKER.length + 1;
    if (markerStart < 0 || !blob.startsWith(CODEX_EXEC_CALL_MARKER, markerStart)) {
      continue;
    }
    // Reject a suffix match inside a longer identifier, e.g. `my_exec_command(`.
    const preceding = markerStart > 0 ? blob[markerStart - 1] : '';
    if (preceding && WORD_CHARACTER.test(preceding)) {
      continue;
    }
    const start = index + 1;
    const end = callArgumentEnd(blob, start);
    if (end === null) {
      continue;
    }
    windows.push({ end, start });
    index = end;
  }
  return windows;
};

/**
 * The index of the closing delimiter that ends the argument list opened at
 * `open`, ignoring delimiters inside string literals, or `null` when the call
 * is never terminated.
 */
const callArgumentEnd = (blob: string, open: number): number | null => {
  let depth = 1;
  let quote: string | null = null;
  for (let index = open; index < blob.length; index += 1) {
    const character = blob[index];
    if (quote !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '{' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
};

const safeJsonObject = (blob: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(blob) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Decode the JSON string literal that follows `key:` inside an arbitrary blob.
 *
 * The key may be quoted or bare: the JavaScript-snippet shape writes an object
 * literal (`{cmd:"…"}`), not JSON, and requiring the quotes silently missed
 * 60% of real Codex exec records.
 */
const jsonStringValueForKey = (blob: string, key: string, from: number, to: number): string | null => {
  for (let start = blob.indexOf(key, from); start >= 0 && start < to; start = blob.indexOf(key, start + 1)) {
    // Reject a substring hit inside a longer identifier, e.g. `subcmd`.
    const preceding = start > 0 ? blob[start - 1] : '';
    if (preceding && preceding !== '"' && preceding !== '{' && preceding !== ',' && !WHITESPACE.test(preceding)) {
      continue;
    }
    let index = start + key.length;
    if (blob[index] === '"') {
      index += 1;
    }
    while (blob[index] === ' ' || blob[index] === '\t') {
      index += 1;
    }
    if (blob[index] !== ':') {
      continue;
    }
    index += 1;
    while (blob[index] === ' ' || blob[index] === '\t') {
      index += 1;
    }
    if (blob[index] !== '"') {
      continue;
    }
    let literal = '';
    let cursor = index + 1;
    while (cursor < blob.length) {
      const character = blob[cursor];
      if (character === '\\') {
        literal += blob.slice(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
      if (character === '"') {
        break;
      }
      literal += character;
      cursor += 1;
    }
    try {
      return JSON.parse(`"${literal}"`) as string;
    } catch {
      return null;
    }
  }
  return null;
};

const shellTokens = (command: string): string[] => {
  const tokens = command.match(SHELL_TOKEN) ?? [];
  return tokens.map((token) => {
    const quoted = (token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'));
    return quoted && token.length >= 2 ? token.slice(1, -1) : token;
  });
};

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The command's verb, without its directory or leading environment
 * assignments, so `/usr/bin/sed` and `LC_ALL=C sed` both read as `sed`.
 */
const commandVerb = (tokens: readonly string[]): string => {
  for (const token of tokens) {
    if (ENVIRONMENT_ASSIGNMENT.test(token)) {
      continue;
    }
    return token.split('/').pop() ?? '';
  }
  return '';
};

/**
 * Shell separators. Real commands routinely wrap the read in a compound —
 * `set -euo pipefail; sed -n '1,240p' …/SKILL.md` — so the verb is taken from
 * the segment that actually names the document rather than from the head of
 * the whole command, which would be `set`.
 */
const SHELL_SEGMENT = /[;\n]|&&|\|\||\|/;

/**
 * The name-and-directory half of the exec matcher, split out so a streaming
 * parser can run it per line and retain only the match — never the command
 * string, which is unbounded and carries whatever the model typed.
 *
 * Accepts either a raw tool-call payload or an already-decoded command.
 */
export const matchCodexSkillDocuments = (blob: unknown): CodexSkillCatalogueEntry[] => {
  if (typeof blob !== 'string' || !blob.includes('SKILL.md')) {
    return [];
  }
  const entries: CodexSkillCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const command of decodeCodexCommands(blob)) {
    for (const segment of command.split(SHELL_SEGMENT)) {
      // One past the ceiling, so the caller can tell a bounded list from a
      // complete one. See `extractCodexSkillCatalogue`.
      for (const token of segmentReadOperands(segment)) {
        // Checked per token, not per segment: one `cat` can name any number of
        // documents, so a per-segment check leaves the token loop unbounded and
        // the ceiling never trips.
        if (entries.length > codexSkillObservationCeiling()) {
          return entries;
        }
        const matched = CODEX_SKILL_DOCUMENT_TOKEN.exec(token);
        const name = matched?.[1];
        if (!name || seen.has(name)) {
          continue;
        }
        seen.add(name);
        entries.push({ name, path: codexSkillDirectory(token) });
      }
    }
  }
  return entries;
};

/**
 * The tokens of one command segment that are plausibly *files being read*.
 *
 * Three things disqualify a token, and each of them was a false inferred
 * invocation before it was handled:
 *
 * - the segment's verb does not read at all (`rm …/SKILL.md`);
 * - the token sits in redirect-target position, so it is being written
 *   (`cat README.md > …/SKILL.md`);
 * - the verb takes a pattern or script first, and the token is that operand
 *   (`rg …/SKILL.md transcript.txt` searches *for* the path).
 *
 * The verb is judged per segment, so `set -e; sed -n … SKILL.md` still reads.
 */
const segmentReadOperands = (segment: string): string[] => {
  const tokens = shellTokens(segment);
  const verb = commandVerb(tokens);
  const scripted = CODEX_SCRIPTED_READ_VERBS.has(verb);
  if (!(scripted || CODEX_READ_VERBS.has(verb))) {
    return [];
  }
  const valuedFlags = CODEX_VALUED_FLAGS.get(verb);
  const operands: string[] = [];
  let seenVerb = false;
  let redirectPending = false;
  let flagValuePending = false;
  let patternSupplied = false;
  let operandIndex = 0;
  for (const token of tokens) {
    if (REDIRECT_OPERATOR.test(token)) {
      // `>` alone takes the next token; `>out` already carries its target.
      redirectPending = token.replace(REDIRECT_OPERATOR, '').length === 0;
      continue;
    }
    if (redirectPending) {
      redirectPending = false;
      continue;
    }
    if (!seenVerb) {
      if (ENVIRONMENT_ASSIGNMENT.test(token)) {
        continue;
      }
      seenVerb = true;
      continue;
    }
    if (flagValuePending) {
      flagValuePending = false;
      continue;
    }
    if (isFlag(token)) {
      if (verb === 'sed' && SED_IN_PLACE.test(token)) {
        // An in-place edit rewrites the document and shows the model nothing.
        return [];
      }
      const parsed = parseFlagToken(token, valuedFlags, scripted);
      patternSupplied ||= parsed.suppliesPattern;
      flagValuePending = parsed.takesNextToken;
      continue;
    }
    operandIndex += 1;
    // The first positional operand of a scripted verb is its pattern or script,
    // unless a flag already supplied one.
    if (scripted && !patternSupplied && operandIndex === 1) {
      continue;
    }
    operands.push(token);
  }
  return operands;
};

/** Project matched skill documents into `inferred` observations. */
export const codexSkillExecObservations = (
  entries: readonly CodexSkillCatalogueEntry[],
  callId: string,
  context: CodexSkillObservationContext,
): SkillObservationExtraction => {
  const observations: SkillObservation[] = [];
  let rejected = 0;
  for (const entry of entries) {
    const observation = parseSkillObservation({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: `exec:${callId}:${entry.name}`,
      observedAt: context.observedAt,
      projectPath: context.projectPath,
      resolvedPath: entry.path,
      sessionId: context.sessionId,
      skillName: entry.name,
      // The command's exit status is in a separate output record; a read that
      // is merely inferred cannot honestly claim an outcome.
      success: null,
      tier: 'inferred',
    });
    if (observation) {
      observations.push(observation);
    } else {
      rejected += 1;
    }
  }
  return { observations, rejected, truncated: false };
};
