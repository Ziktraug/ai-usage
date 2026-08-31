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
 * Testing override for each tier's per-session observation ceiling, mirroring
 * the OpenCode read-budget seam. The production ceiling guards a corrupt
 * session rather than ordinary volume, so exercising the bound honestly would
 * mean building 4096 entries; lowering it keeps the test about the behaviour —
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
  `^(?:~|\\.{1,2})?(?:/[\\w.:@+-]+)*/skills/(?:\\.system/)?(${CODEX_SKILL_NAME_SEGMENT}(?::${CODEX_SKILL_NAME_SEGMENT})*)/SKILL\\.md$`,
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
  readonly booleanLong: ReadonlySet<string>;
  readonly booleanShort: ReadonlySet<string>;
  readonly valuedLong: ReadonlySet<string>;
  readonly valuedShort: ReadonlySet<string>;
}

const verbFlags = (
  booleanShort: string,
  valuedShort: string,
  booleanLong: readonly string[],
  valuedLong: readonly string[],
): CodexVerbFlags => ({
  booleanLong: new Set(booleanLong),
  booleanShort: new Set(booleanShort),
  valuedLong: new Set(valuedLong),
  valuedShort: new Set(valuedShort),
});

/**
 * The flags each read verb is modelled to understand.
 *
 * Membership is asymmetric on purpose. A valued flag wrongly listed as boolean
 * leaves its value sitting in operand position, which is an over-count — the
 * one error class this module refuses. A boolean wrongly listed as valued only
 * swallows a token, which is an under-count. So anything uncertain belongs in
 * the valued sets, and the common flags are pinned exactly, per verb: `-n` is
 * boolean for `sed` and `grep`, but takes a value for `head`, `tail` and `nl`.
 */
const CODEX_VERB_FLAGS: ReadonlyMap<string, CodexVerbFlags> = new Map([
  [
    'cat',
    verbFlags(
      'AbEensTtuv',
      '',
      [
        '--show-all',
        '--number-nonblank',
        '--show-ends',
        '--number',
        '--squeeze-blank',
        '--show-tabs',
        '--show-nonprinting',
      ],
      [],
    ),
  ],
  ['head', verbFlags('qvz', 'nc', ['--quiet', '--silent', '--verbose', '--zero-terminated'], ['--lines', '--bytes'])],
  [
    'tail',
    verbFlags(
      'fFqvz',
      'ncs',
      ['--quiet', '--silent', '--verbose', '--zero-terminated', '--follow', '--retry'],
      ['--lines', '--bytes', '--sleep-interval', '--pid', '--max-unchanged-stats'],
    ),
  ],
  [
    'nl',
    verbFlags(
      'p',
      'bdfhilnsvw',
      ['--no-renumber'],
      [
        '--body-numbering',
        '--section-delimiter',
        '--footer-numbering',
        '--header-numbering',
        '--line-increment',
        '--join-blank-lines',
        '--number-format',
        '--number-separator',
        '--starting-line-number',
        '--number-width',
      ],
    ),
  ],
  ['wc', verbFlags('clLmw', '', ['--bytes', '--chars', '--lines', '--max-line-length', '--words'], ['--files0-from'])],
  [
    'less',
    verbFlags(
      'EFGImNQRSXin',
      'jkoptx',
      ['--quit-at-eof', '--RAW-CONTROL-CHARS', '--chop-long-lines'],
      ['--tabs', '--prompt'],
    ),
  ],
  ['more', verbFlags('dfpcsu', 'n', [], [])],
  ['view', verbFlags('RmMnb', 'cuS', [], [])],
  [
    'bat',
    verbFlags(
      'ApnA',
      'lrHm',
      ['--plain', '--number', '--show-all', '--no-config', '--force-colorization', '--list-themes'],
      [
        '--language',
        '--style',
        '--theme',
        '--paging',
        '--color',
        '--decorations',
        '--line-range',
        '--wrap',
        '--tabs',
        '--italic-text',
        '--map-syntax',
        '--pager',
        '--terminal-width',
      ],
    ),
  ],
  [
    'sed',
    verbFlags(
      'nrsuEz',
      'efl',
      [
        '--quiet',
        '--silent',
        '--regexp-extended',
        '--separate',
        '--unbuffered',
        '--null-data',
        '--debug',
        '--posix',
        '--sandbox',
      ],
      ['--expression', '--file', '--line-length'],
    ),
  ],
  [
    'grep',
    verbFlags(
      'EFGPabcHhIiLlnoqRrsUvwxyzZ',
      'ABCDdefm',
      [
        '--extended-regexp',
        '--fixed-strings',
        '--basic-regexp',
        '--perl-regexp',
        '--text',
        '--byte-offset',
        '--count',
        '--with-filename',
        '--no-filename',
        '--ignore-case',
        '--files-without-match',
        '--files-with-matches',
        '--line-number',
        '--only-matching',
        '--quiet',
        '--silent',
        '--recursive',
        '--dereference-recursive',
        '--no-messages',
        '--invert-match',
        '--word-regexp',
        '--line-regexp',
        '--null',
        '--null-data',
        '--initial-tab',
        '--line-buffered',
        '--no-ignore-case',
      ],
      [
        '--after-context',
        '--before-context',
        '--context',
        '--devices',
        '--directories',
        '--exclude',
        '--exclude-dir',
        '--exclude-from',
        '--file',
        '--include',
        '--max-count',
        '--regexp',
        '--binary-files',
        '--color',
        '--colour',
        '--label',
        '--group-separator',
      ],
    ),
  ],
  [
    'rg',
    verbFlags(
      'FLPSUVachilnopqsuvwxz',
      'ABCDEMTdefgjmrt',
      [
        '--fixed-strings',
        '--follow',
        '--pcre2',
        '--smart-case',
        '--multiline',
        '--count',
        '--count-matches',
        '--hidden',
        '--ignore-case',
        '--files-with-matches',
        '--files-without-match',
        '--line-number',
        '--no-line-number',
        '--only-matching',
        '--no-filename',
        '--with-filename',
        '--quiet',
        '--case-sensitive',
        '--unrestricted',
        '--invert-match',
        '--word-regexp',
        '--line-regexp',
        '--null',
        '--json',
        '--files',
        '--no-ignore',
        '--no-heading',
        '--heading',
        '--vimgrep',
        '--text',
        '--search-zip',
        '--trim',
        '--stats',
        '--debug',
        '--no-config',
        '--one-file-system',
        '--crlf',
        '--column',
        '--block-buffered',
        '--line-buffered',
      ],
      [
        '--after-context',
        '--before-context',
        '--context',
        '--dfa-size-limit',
        '--encoding',
        '--engine',
        '--file',
        '--glob',
        '--iglob',
        '--ignore-file',
        '--max-columns',
        '--max-count',
        '--max-depth',
        '--max-filesize',
        '--regex-size-limit',
        '--regexp',
        '--replace',
        '--sort',
        '--sortr',
        '--threads',
        '--type',
        '--type-add',
        '--type-not',
        '--colors',
        '--color',
        '--colour',
        '--context-separator',
        '--field-context-separator',
        '--field-match-separator',
        '--path-separator',
        '--pre',
        '--binary-files',
      ],
    ),
  ],
  [
    'awk',
    verbFlags(
      '',
      'Ffv',
      ['--posix', '--traditional', '--lint'],
      ['--assign', '--field-separator', '--file', '--source', '--exec'],
    ),
  ],
]);

/**
 * Flags that supply the pattern or script themselves. When one is present the
 * first positional operand is already a file, so skipping it as "the pattern"
 * would lose a real read: `grep -e needle …/SKILL.md` and its glued form
 * `grep -eneedle …/SKILL.md` both read the skill.
 */
const CODEX_PATTERN_SUPPLYING_LONG: ReadonlySet<string> = new Set(['--expression', '--file', '--regexp', '--source']);
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
 * Interpret one flag token, or refuse.
 *
 * Short flags cluster (`-nm 1` is `-n -m 1`) and glue their values
 * (`-eneedle`), and getting either wrong shifts every operand after it — which
 * is how a pattern ends up read as a file.
 *
 * Two limits are assumed rather than closed, both measured against the real
 * corpus before being accepted:
 *
 * - **A quoted dash-word is treated as an operand, not a flag**, so
 *   `rg "--" …/SKILL.md f` can over-count. The corpus contains exactly three
 *   quoted dash-words and all three are data operands that this behaviour reads
 *   correctly; refusing quoted dash-words would break real reads to defend
 *   against a construction with zero measured incidence.
 * - **Compound shell constructs are not interpreted.** This matcher reads the
 *   grammar of a command line; it does not execute one, and it does not
 *   reimplement the tools a command names. So text that *looks* like a read,
 *   inside a construct that would not perform one, can still be counted:
 *
 *   - a conditional chain that never runs (`false && cat …/SKILL.md`);
 *   - a heredoc body, whose lines are re-scanned as commands
 *     (`cat <<'EOF' … EOF`);
 *   - a function body that is defined and never invoked (`f() { cat X }`);
 *   - a flag *value* that the real tool would reject, since values are not
 *     domain-validated (`head --lines=bogus …/SKILL.md` counts, though `head`
 *     would error out first).
 *
 *   Each would require either interpreting shell execution or re-implementing
 *   the tool's own argument validation. Every one of these constructs has zero
 *   incidence in the measured corpus, and the cheap approximations that would
 *   exclude them — dropping post-`&&`/`||` segments, refusing anything after a
 *   `<<` — would discard common genuine reads such as
 *   `cd repo && cat …/SKILL.md`.
 *
 * Both limits err toward a rare false observation on synthetic input. That is
 * the honest reason this tier is labelled `inferred`, kept separate from
 * `declared`, and never summed with it.
 *
 * Related stated property: the structural key scan is depth-agnostic within a
 * call's window. It finds a structural `cmd` at any nesting level inside the
 * argument, rather than only at the top level of the argument object.
 *
 * **An unmodeled flag returns `null`, and the caller abandons the segment.**
 * Arity cannot be guessed from the token, and guessing either way is reachable
 * as a false read: assume boolean and its value sits in operand position;
 * assume valued and a real file gets swallowed. Since the modelled sets cover
 * the flags real Codex commands actually use, refusing the rest makes
 * flag-driven over-counts impossible by construction. The cost is that a
 * segment using an unfamiliar flag reports nothing — an under-count, which is
 * the direction this tier is required to err.
 */
const parseFlagToken = (token: string, flags: CodexVerbFlags | undefined): ParsedFlag | null => {
  if (flags === undefined) {
    return null;
  }
  if (token === '--') {
    // End of options: everything after it is an operand, which the caller
    // already treats as the default.
    return { suppliesPattern: false, takesNextToken: false };
  }
  if (token.startsWith('--')) {
    const separator = token.indexOf('=');
    const name = separator < 0 ? token : token.slice(0, separator);
    const suppliesPattern = CODEX_PATTERN_SUPPLYING_LONG.has(name);
    if (flags.valuedLong.has(name)) {
      return { suppliesPattern, takesNextToken: separator < 0 };
    }
    if (flags.booleanLong.has(name)) {
      // A boolean flag arriving with a value is not something the real tool
      // accepts, so the input is outside the modelled grammar.
      return separator < 0 ? { suppliesPattern, takesNextToken: false } : null;
    }
    return null;
  }
  // A short cluster is read left to right; the first letter that takes a value
  // claims the rest of the token, or the next token when nothing is glued.
  const letters = token.slice(1);
  for (const [index, letter] of [...letters].entries()) {
    const suppliesPattern = CODEX_PATTERN_SUPPLYING_SHORT.has(letter);
    if (flags.valuedShort.has(letter)) {
      return { suppliesPattern, takesNextToken: index === letters.length - 1 };
    }
    if (!flags.booleanShort.has(letter)) {
      return null;
    }
  }
  return { suppliesPattern: false, takesNextToken: false };
};

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
 * scan stops at the next heading, and one entry past the exposure ceiling.
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
 * A command a payload runs, in the form the payload settled it.
 *
 * The distinction is load-bearing. An argv array has *already* decided its word
 * boundaries; re-joining it into a string and re-tokenizing throws that away and
 * lets a word's contents invent boundaries the array never had — `["printf",
 * "x;cat ", path]` would re-split into a `cat` command that was never run. Shell
 * strings have no such structure and must be tokenized.
 */
export interface CodexShellCommand {
  kind: 'shell';
  source: string;
}

export interface CodexArgvCommand {
  kind: 'argv';
  words: readonly string[];
}

export type CodexCommand = CodexArgvCommand | CodexShellCommand;

/** The text of the first command a payload runs. Diagnostics only. */
export const decodeCodexCommand = (blob: unknown): string | null => {
  const first = decodeCodexCommands(blob)[0];
  if (first === undefined) {
    return null;
  }
  return first.kind === 'shell' ? first.source : first.words.join(' ');
};

/** The marker a snippet uses to invoke the shell, so a key can be tied to its call. */
const CODEX_EXEC_CALL_MARKER = 'exec_command(';

/**
 * Every command a payload actually executes.
 *
 * A snippet may contain more than one `exec_command(...)` call, and may contain
 * the string `cmd` in places that are not one — a local variable, a comment, a
 * quoted sentence. A key therefore counts only when it is *structural*: a bare
 * identifier or a complete quoted key at the current level, inside the argument
 * list of an actual call, bounded by that call's own balanced closer.
 *
 * There is deliberately no whole-blob fallback once a call marker exists. A
 * `cmd` outside every call is not a command this payload ran.
 */
export const decodeCodexCommands = (blob: unknown): CodexCommand[] => {
  if (typeof blob !== 'string' || blob.length === 0) {
    return [];
  }
  const parsed = safeJsonObject(blob);
  if (parsed) {
    if (typeof parsed.cmd === 'string') {
      return [{ kind: 'shell', source: parsed.cmd }];
    }
    if (typeof parsed.command === 'string') {
      return [{ kind: 'shell', source: parsed.command }];
    }
    if (Array.isArray(parsed.command)) {
      // Structural: the array already settled its words, so they are carried
      // through as words and never re-tokenized.
      const words = parsed.command.filter((word): word is string => typeof word === 'string');
      return words.length === parsed.command.length && words.length > 0 ? [{ kind: 'argv', words }] : [];
    }
    return [];
  }
  const commands: CodexCommand[] = [];
  // Comments are blanked first, offset-preserving, so a commented-out `cmd`
  // cannot win the key scan against the one the call actually ran.
  const source = withoutJavaScriptComments(blob);
  for (const { end, start } of codexExecCallWindows(source)) {
    const command =
      structuralStringValueForKey(source, 'cmd', start, end) ??
      structuralStringValueForKey(source, 'command', start, end);
    if (command !== null) {
      commands.push({ kind: 'shell', source: command });
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
const CLOSER_FOR: ReadonlyMap<string, string> = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
]);

const callArgumentEnd = (blob: string, open: number): number | null => {
  // A stack, not a depth counter: counting alone accepts `{cmd:"…"]`, because a
  // mismatched closer still balances the count. A mismatch means the snippet is
  // not the grammar this module models, so the call is malformed and yields
  // nothing.
  const expected: string[] = [')'];
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
    const closer = character === undefined ? undefined : CLOSER_FOR.get(character);
    if (closer !== undefined) {
      expected.push(closer);
      continue;
    }
    if (character === ')' || character === '}' || character === ']') {
      if (expected.pop() !== character) {
        return null;
      }
      if (expected.length === 0) {
        return index;
      }
    }
  }
  return null;
};

/**
 * Blank out JavaScript comments, preserving offsets so an already-computed
 * window stays valid.
 *
 * A commented-out `cmd` is not a command the payload ran, but a key scan cannot
 * tell: it finds the first `cmd` in the window, and a `/* cmd:"…" *␘/` sitting
 * ahead of the real one wins. Comments are erased before any key is looked for.
 */
const withoutJavaScriptComments = (blob: string): string => {
  const characters = [...blob];
  let quote: string | null = null;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
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
    if (character !== '/') {
      continue;
    }
    const next = characters[index + 1];
    if (next === '*') {
      let end = index + 2;
      while (end < characters.length && !(characters[end] === '*' && characters[end + 1] === '/')) {
        end += 1;
      }
      const stop = Math.min(end + 2, characters.length);
      for (let blank = index; blank < stop; blank += 1) {
        characters[blank] = ' ';
      }
      index = stop - 1;
      continue;
    }
    if (next === '/') {
      let end = index;
      while (end < characters.length && characters[end] !== '\n') {
        characters[end] = ' ';
        end += 1;
      }
      index = end;
    }
  }
  return characters.join('');
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

const JSON_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

interface StringLiteral {
  /** Index of the closing quote. */
  end: number;
  value: string;
}

/** Read the string literal opening at `open`, or `null` when it never closes. */
const readStringLiteral = (blob: string, open: number): StringLiteral | null => {
  const quote = blob[open];
  let value = '';
  for (let index = open + 1; index < blob.length; index += 1) {
    const character = blob[index];
    // JavaScript, not shell: `\'` is a valid escape inside a single-quoted JS
    // string. Applying the shell rule here — where a backslash is literal
    // inside `'…'` — closed the literal early at an escaped apostrophe, spilled
    // the rest of the prose outside the string, and let the structural scan
    // lift a key out of it. `shellItems` keeps the shell rule, because it reads
    // shell text.
    if (character === '\\') {
      const escaped = blob[index + 1] ?? '';
      value += JSON_ESCAPES.get(escaped) ?? escaped;
      index += 1;
      continue;
    }
    if (character === quote) {
      return { end: index, value };
    }
    value += character;
  }
  return null;
};

const skipBlanks = (blob: string, from: number, to: number): number => {
  let index = from;
  while (index < to && (blob[index] === ' ' || blob[index] === '\t' || blob[index] === '\n')) {
    index += 1;
  }
  return index;
};

/**
 * The string value of a **structural** `key:` inside `[from, to)`.
 *
 * "Structural" is the whole point. A scan that merely looks for the key text
 * finds it inside quoted prose too — `{justification:'please run cmd:"cat …"'}`
 * hands back the sentence's decoy instead of the command the call ran. So a
 * candidate counts only when it is a bare identifier at the current level, or a
 * complete quoted key; a string literal that is *not* exactly the key is
 * skipped whole, contents and all.
 */
const structuralStringValueForKey = (blob: string, key: string, from: number, to: number): string | null => {
  let index = from;
  while (index < to) {
    const character = blob[index];
    if (character === '"' || character === "'" || character === '`') {
      const literal = readStringLiteral(blob, index);
      if (literal === null || literal.end >= to) {
        return null;
      }
      const afterKey = skipBlanks(blob, literal.end + 1, to);
      if (literal.value === key && blob[afterKey] === ':') {
        return structuralStringValue(blob, afterKey + 1, to);
      }
      index = literal.end + 1;
      continue;
    }
    if (blob.startsWith(key, index)) {
      const preceding = index > 0 ? blob[index - 1] : '';
      const afterKey = skipBlanks(blob, index + key.length, to);
      if (!(preceding && WORD_CHARACTER.test(preceding)) && blob[afterKey] === ':') {
        return structuralStringValue(blob, afterKey + 1, to);
      }
    }
    index += 1;
  }
  return null;
};

/** The string a structural key is assigned, or `null` when it is not a string. */
const structuralStringValue = (blob: string, from: number, to: number): string | null => {
  const start = skipBlanks(blob, from, to);
  const character = blob[start];
  if (character !== '"' && character !== "'" && character !== '`') {
    return null;
  }
  const literal = readStringLiteral(blob, start);
  return literal === null || literal.end >= to ? null : literal.value;
};

interface ShellWord {
  kind: 'word';
  /** Any part of the token was quoted, so it can never be an operator or flag. */
  quoted: boolean;
  value: string;
}

interface ShellOperator {
  kind: 'operator';
  value: string;
}

type ShellItem = ShellOperator | ShellWord;

/** Separators that end one command and begin another. */
const SHELL_SEPARATORS: ReadonlySet<string> = new Set(['\n', '&', '&&', ';', ';;', '|', '||']);

/**
 * Operators that consume the following word as a redirection target. `<` forms
 * are included even though they read: the target is excluded either way, which
 * costs an occasional under-count and removes any need to reason about which
 * direction a form points.
 */
const SHELL_REDIRECTS: ReadonlySet<string> = new Set(['&>', '&>>', '<', '<<', '<<<', '<>', '>', '>&', '>>', '>|']);

/** Longest-first, so `&>>` is never read as `&` followed by `>>`. */
const SHELL_OPERATOR_FORMS: readonly string[] = [
  '&>>',
  '<<<',
  '&&',
  '&>',
  ';;',
  '<<',
  '<>',
  '>&',
  '>>',
  '>|',
  '||',
  '&',
  ';',
  '<',
  '>',
  '|',
  '\n',
];

const ALL_DIGITS = /^\d+$/;

/**
 * Split a command into words and operators in one quote-aware pass.
 *
 * Doing this before segmentation is what closes a family of false reads: a
 * regex split on `;` or `|` fires inside `printf 'x;cat '`, inventing a segment
 * whose verb came out of a quoted string. Here a quoted run can only ever be
 * part of a word, so it can neither separate commands nor act as an operator.
 *
 * An unquoted `#` at the start of a word begins a shell comment and ends the
 * command; everything after it was never executed.
 */
const shellItems = (command: string): ShellItem[] | null => {
  const items: ShellItem[] = [];
  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (character === ' ' || character === '\t' || character === '\r') {
      index += 1;
      continue;
    }
    if (character === '#') {
      break;
    }
    const operator = SHELL_OPERATOR_FORMS.find((form) => command.startsWith(form, index));
    if (operator !== undefined) {
      // A bare file-descriptor number belongs to the redirect, not to the words.
      const previous = items.at(-1);
      if (
        previous?.kind === 'word' &&
        !previous.quoted &&
        ALL_DIGITS.test(previous.value) &&
        (operator.includes('>') || operator.includes('<'))
      ) {
        items.pop();
      }
      items.push({ kind: 'operator', value: operator });
      index += operator.length;
      continue;
    }
    let value = '';
    let quoted = false;
    while (index < command.length) {
      const current = command[index];
      if (current === ' ' || current === '\t' || current === '\r') {
        break;
      }
      if (SHELL_OPERATOR_FORMS.some((form) => command.startsWith(form, index))) {
        break;
      }
      if (current === "'" || current === '"' || current === '`') {
        quoted = true;
        index += 1;
        let closed = false;
        while (index < command.length) {
          if (command[index] === current) {
            closed = true;
            break;
          }
          if (command[index] === '\\' && current !== "'") {
            index += 1;
          }
          value += command[index] ?? '';
          index += 1;
        }
        if (!closed) {
          // A real shell rejects an unterminated quote before running anything,
          // so there is no command here to draw an observation from.
          return null;
        }
        index += 1;
        continue;
      }
      if (current === '\\') {
        index += 1;
        value += command[index] ?? '';
        index += 1;
        continue;
      }
      value += current;
      index += 1;
    }
    items.push({ kind: 'word', quoted, value });
  }
  return items;
};

/**
 * The command segments to scan, in the form the payload settled.
 *
 * An argv array is already tokenized, so it becomes exactly one segment of
 * words: never re-split, never re-read for operators, never re-segmented. That
 * is what stops a word's *contents* from inventing structure the array never
 * had — `["printf", "x;cat ", path]` is one `printf` invocation, not a `printf`
 * followed by a `cat`. Redirections and separators cannot exist in argv either,
 * because the array is the argument vector, not a shell line.
 *
 * A shell string has no such structure and is tokenized; an unterminated quote
 * makes it unrunnable, and yields nothing.
 */
const commandSegments = (command: CodexCommand): ShellItem[][] => {
  if (command.kind === 'argv') {
    return [command.words.map((value): ShellItem => ({ kind: 'word', quoted: false, value }))];
  }
  const items = shellItems(command.source);
  return items === null ? [] : shellSegments(items);
};

/** Split an item list into the individual commands it runs. */
const shellSegments = (items: readonly ShellItem[]): ShellItem[][] => {
  const segments: ShellItem[][] = [[]];
  for (const item of items) {
    if (item.kind === 'operator' && SHELL_SEPARATORS.has(item.value)) {
      segments.push([]);
      continue;
    }
    segments.at(-1)?.push(item);
  }
  return segments;
};

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * The command's verb, without its directory or leading environment
 * assignments, so `/usr/bin/sed` and `LC_ALL=C sed` both read as `sed`.
 */
const commandVerb = (items: readonly ShellItem[]): string => {
  for (const item of items) {
    if (item.kind !== 'word' || ENVIRONMENT_ASSIGNMENT.test(item.value)) {
      continue;
    }
    return item.value.split('/').pop() ?? '';
  }
  return '';
};

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
    for (const segment of commandSegments(command)) {
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
const segmentReadOperands = (items: readonly ShellItem[]): string[] => {
  const verb = commandVerb(items);
  const scripted = CODEX_SCRIPTED_READ_VERBS.has(verb);
  if (!(scripted || CODEX_READ_VERBS.has(verb))) {
    return [];
  }
  const knownFlags = CODEX_VERB_FLAGS.get(verb);
  const operands: string[] = [];
  let seenVerb = false;
  let redirectPending = false;
  let flagValuePending = false;
  let patternSupplied = false;
  let operandIndex = 0;
  for (const item of items) {
    if (item.kind === 'operator') {
      redirectPending = SHELL_REDIRECTS.has(item.value);
      continue;
    }
    if (redirectPending) {
      redirectPending = false;
      continue;
    }
    if (!seenVerb) {
      if (ENVIRONMENT_ASSIGNMENT.test(item.value)) {
        continue;
      }
      seenVerb = true;
      continue;
    }
    if (flagValuePending) {
      flagValuePending = false;
      continue;
    }
    if (!item.quoted && isFlag(item.value)) {
      if (verb === 'sed' && SED_IN_PLACE.test(item.value)) {
        return [];
      }
      const parsed = parseFlagToken(item.value, knownFlags);
      if (parsed === null) {
        // An unmodeled flag. Its arity is unknown, so every operand position
        // after it is unknown too - which is exactly how a pattern ends up read
        // as a file. The segment is abandoned rather than guessed at.
        return [];
      }
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
    operands.push(item.value);
  }
  return operands;
};

/**
 * Project matched skill documents into `inferred` observations.
 *
 * A session catalogue may refine a path-derived basename to its namespaced
 * skill name. The observation key deliberately keeps the path-derived name:
 * it is part of the stable event identity, while `skillName` is mutable fact
 * content that a later sweep may correct in place.
 */
export const codexSkillExecObservations = (
  entries: readonly CodexSkillCatalogueEntry[],
  callId: string,
  context: CodexSkillObservationContext,
  catalogueNamesByPath?: ReadonlyMap<string, string | null>,
): SkillObservationExtraction => {
  const observations: SkillObservation[] = [];
  let rejected = 0;
  for (const entry of entries) {
    const catalogueName = entry.path === null ? undefined : catalogueNamesByPath?.get(entry.path);
    const observation = parseSkillObservation({
      argsPresent: null,
      harnessKey: 'codex',
      observationKey: `exec:${callId}:${entry.name}`,
      observedAt: context.observedAt,
      projectPath: context.projectPath,
      resolvedPath: entry.path,
      sessionId: context.sessionId,
      skillName: typeof catalogueName === 'string' ? catalogueName : entry.name,
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
