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
 * scan stops at the next heading, and at the per-session observation ceiling.
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
    if (entries.length >= MAX_SKILL_OBSERVATIONS_PER_SESSION) {
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
 * the string `cmd` in places that are not one. Taking the first `cmd` in the
 * blob would therefore both miss later commands and risk attributing an
 * unrelated key to the call. Each call's argument object is scanned in its own
 * window instead — from the call marker up to the next one — so a decoded
 * command always belongs to the call it was read from.
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
  // The JavaScript-snippet shape is not parseable as a whole, so each embedded
  // object literal is decoded in place, scoped to its own call.
  const commands: string[] = [];
  const callStarts: number[] = [];
  for (
    let index = blob.indexOf(CODEX_EXEC_CALL_MARKER);
    index >= 0;
    index = blob.indexOf(CODEX_EXEC_CALL_MARKER, index + 1)
  ) {
    callStarts.push(index + CODEX_EXEC_CALL_MARKER.length);
  }
  for (const [position, start] of callStarts.entries()) {
    const end = callStarts[position + 1] ?? blob.length;
    const command =
      jsonStringValueForKey(blob, 'cmd', start, end) ?? jsonStringValueForKey(blob, 'command', start, end);
    if (command !== null) {
      commands.push(command);
    }
  }
  if (commands.length > 0) {
    return commands;
  }
  // No recognizable call marker: fall back to a whole-blob scan rather than
  // silently reporting a payload that plainly carries a command as empty.
  const fallback =
    jsonStringValueForKey(blob, 'cmd', 0, blob.length) ?? jsonStringValueForKey(blob, 'command', 0, blob.length);
  return fallback === null ? [] : [fallback];
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
  const commands = decodeCodexCommands(blob);
  const entries: CodexSkillCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const command of commands.length > 0 ? commands : [blob]) {
    for (const segment of command.split(SHELL_SEGMENT)) {
      if (entries.length >= MAX_SKILL_OBSERVATIONS_PER_SESSION) {
        return entries;
      }
      for (const token of segmentReadOperands(segment)) {
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
  const operands: string[] = [];
  let seenVerb = false;
  let redirectPending = false;
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
    if (isFlag(token)) {
      continue;
    }
    operandIndex += 1;
    if (scripted && operandIndex === 1) {
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
