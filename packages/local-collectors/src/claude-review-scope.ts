import { createHash } from 'node:crypto';
import {
  BoundedProcessError,
  boundedProcessEnvironment,
  executeBoundedProcess,
} from '@ai-usage/local-machine/bounded-process';
import { isPrintableSkillObservationText } from '@ai-usage/report-core/skill-observation';
import {
  GIT_EMPTY_TREE,
  parseReviewAttemptScope,
  REVIEW_ATTEMPT_BOUNDS,
  type ReviewAttemptScope,
  type ReviewScopeFile,
  type ReviewScopeFileStatus,
} from '@ai-usage/report-core/work-attempts';

/**
 * The scope of a launched review (ADR 0055), prepared on the engine's side with git, never by the
 * reviewing agent: exactly one commit.
 *
 * 1. `HEAD` is resolved to a SHA first; every later read names that SHA, never `HEAD`.
 * 2. The commit object gives its parents; the base is the first parent (a merge is compared with
 *    its first parent only), or the empty tree for a root commit.
 * 3. `git diff-tree -p` between base and SHA produces the patch, with external diff drivers and
 *    text conversion disabled, no colour, rename detection, fixed prefixes and context, and no
 *    pager. A patch over `maxPatchReadBytes`, or one that is not UTF-8 text, is refused.
 * 4. The patch is cut, at a line boundary, to the prompt's byte and line budget; each file says
 *    whether the review received all of its patch, a prefix, nothing, or only a binary notice.
 * 5. A dirty working tree is stated (files the agent reads may differ from the commit), and `HEAD`
 *    is resolved again at the end: a moved `HEAD` refuses the scope rather than mixing revisions.
 *
 * Every git call is a bounded process with the shared environment allow-list, no prompt
 * (`GIT_TERMINAL_PROMPT=0`) and no optional lock, so preparing a scope never writes the index.
 */
export type ReviewScopeFailureKind =
  | 'binary-only'
  | 'blob-not-local'
  | 'empty'
  | 'git-failed'
  | 'moved'
  | 'no-commit'
  | 'not-text'
  | 'too-large';

export class ReviewScopeError extends Error {
  readonly kind: ReviewScopeFailureKind;

  constructor(kind: ReviewScopeFailureKind, message: string) {
    super(message);
    this.name = 'ReviewScopeError';
    this.kind = kind;
  }
}

export interface ReviewPatchLimits {
  readonly maxPatchPromptBytes: number;
  readonly maxPatchPromptLines: number;
  readonly maxPatchReadBytes: number;
}

export interface PreparedReviewScope {
  /** The patch prefix the prompt carries: exactly the first `scope.includedBytes` bytes of the patch. */
  readonly patch: string;
  readonly scope: ReviewAttemptScope;
}

export interface PrepareReviewScopeOptions {
  /** Test seam: runs after the patch was read and before `HEAD` is resolved again. */
  readonly beforeHeadRecheck?: () => Promise<void>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly limits?: Partial<ReviewPatchLimits>;
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_PATCH_TIMEOUT_MS = 30_000;
const GIT_SMALL_OUTPUT_BYTES = 1024 * 1024;
/**
 * Global options of every call: no pager, no optional lock, raw non-ASCII paths, no fsmonitor, no
 * colour, and no automatic maintenance or garbage collection started in the operator's repository.
 */
const GIT_GLOBAL_OPTIONS = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'color.ui=never',
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
] as const;
/**
 * Forced on every call: no prompt, no optional lock, and no lazy fetch. In a partial clone a
 * missing object would otherwise be fetched from the promisor remote (network, credential
 * helpers, a new pack in `.git/objects`); with `GIT_NO_LAZY_FETCH` the read fails instead and the
 * scope is refused as `blob-not-local`.
 */
const GIT_SCOPE_ENVIRONMENT = {
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
} as const;
/** The patch options, explicit so no repository or user configuration changes what is reviewed. */
export const REVIEW_DIFF_TREE_OPTIONS = [
  'diff-tree',
  '-r',
  '-p',
  '-M',
  '--no-commit-id',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--submodule=short',
  '--unified=3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
] as const;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIFF_HEADER = 'diff --git ';
const TRAILING_NEWLINE = /\n$/u;
const OCTAL_DIGIT = /^[0-7]$/u;
const C_ESCAPES: Readonly<Record<string, number>> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/**
 * Reads one git C-quoted path (`"a/x\tb"`, octal bytes included) from the start of `text`; returns
 * the decoded value and what follows it, or `null` when the quoting is not closed.
 */
const readQuoted = (text: string): { readonly rest: string; readonly value: string } | null => {
  const bytes: number[] = [];
  let index = 1;
  while (index < text.length) {
    const character = text[index] ?? '';
    if (character === '"') {
      return { rest: text.slice(index + 1), value: new TextDecoder().decode(new Uint8Array(bytes)) };
    }
    if (character === '\\') {
      const next = text[index + 1] ?? '';
      if (OCTAL_DIGIT.test(next)) {
        bytes.push(Number.parseInt(text.slice(index + 1, index + 4), 8) % 256);
        index += 4;
        continue;
      }
      const escaped = C_ESCAPES[next];
      if (escaped === undefined) {
        return null;
      }
      bytes.push(escaped);
      index += 2;
      continue;
    }
    const codePoint = text.codePointAt(index) ?? 0;
    const unit = String.fromCodePoint(codePoint);
    bytes.push(...encoder.encode(unit));
    index += unit.length;
  }
  return null;
};

const stripPrefix = (value: string, prefix: string): string | null =>
  value.startsWith(prefix) ? value.slice(prefix.length) : null;

/** A `---`/`+++` operand: `/dev/null`, a prefixed path, or a quoted one; git appends a tab after names with spaces. */
const markerPath = (operand: string, prefix: string): string | null => {
  const value = operand.endsWith('\t') ? operand.slice(0, -1) : operand;
  if (value === '/dev/null') {
    return null;
  }
  if (value.startsWith('"')) {
    const quoted = readQuoted(value);
    return quoted === null ? null : stripPrefix(quoted.value, prefix);
  }
  return stripPrefix(value, prefix);
};

const lineOperand = (value: string): string | null => {
  if (value.startsWith('"')) {
    return readQuoted(value)?.value ?? null;
  }
  return value;
};

/** The two paths of `diff --git a/X b/Y`; unquoted paths with spaces are resolved only when both are equal. */
const headerPaths = (line: string): { readonly after: string; readonly before: string } | null => {
  const rest = line.slice(DIFF_HEADER.length);
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (first === null || !first.rest.startsWith(' ')) {
      return null;
    }
    const secondText = first.rest.slice(1);
    const second = secondText.startsWith('"') ? readQuoted(secondText)?.value : secondText;
    const before = stripPrefix(first.value, 'a/');
    const after = second === undefined ? null : stripPrefix(second, 'b/');
    return before === null || after === null ? null : { after, before };
  }
  const quotedSecond = rest.indexOf(' "b/');
  if (quotedSecond > 0) {
    const second = readQuoted(rest.slice(quotedSecond + 1));
    const before = stripPrefix(rest.slice(0, quotedSecond), 'a/');
    const after = second === null ? null : stripPrefix(second.value, 'b/');
    return before === null || after === null ? null : { after, before };
  }
  if ((rest.length - 5) % 2 === 0) {
    const length = (rest.length - 5) / 2;
    const candidate = rest.slice(2, 2 + length);
    if (rest === `a/${candidate} b/${candidate}`) {
      return { after: candidate, before: candidate };
    }
  }
  return null;
};

interface PatchSection {
  readonly binary: boolean;
  readonly endLine: number;
  readonly file: Omit<ReviewScopeFile, 'coverage'>;
  readonly startLine: number;
}

const readSection = (lines: readonly string[], startLine: number, endLine: number): PatchSection => {
  const header = headerPaths((lines[startLine] ?? '').replace(TRAILING_NEWLINE, ''));
  let status: ReviewScopeFileStatus = 'modified';
  let before: string | null = null;
  let after: string | null = null;
  let movedFrom: string | null = null;
  let movedTo: string | null = null;
  let binary = false;
  let inHunk = false;
  let additions = 0;
  let deletions = 0;
  for (let index = startLine + 1; index < endLine; index++) {
    const line = (lines[index] ?? '').replace(TRAILING_NEWLINE, '');
    if (inHunk) {
      if (line.startsWith('+')) {
        additions += 1;
      } else if (line.startsWith('-')) {
        deletions += 1;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
    } else if (line.startsWith('new file mode')) {
      status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
    } else if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      status = line.startsWith('rename') ? 'renamed' : 'copied';
      movedFrom = lineOperand(line.slice(line.indexOf(' from ') + 6));
    } else if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      movedTo = lineOperand(line.slice(line.indexOf(' to ') + 4));
    } else if (line.startsWith('--- ')) {
      before = markerPath(line.slice(4), 'a/');
    } else if (line.startsWith('+++ ')) {
      after = markerPath(line.slice(4), 'b/');
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
    }
  }
  const moved = status === 'renamed' || status === 'copied';
  const path = (moved ? movedTo : null) ?? after ?? before ?? header?.after ?? header?.before ?? '';
  const previousPath = moved ? (movedFrom ?? header?.before ?? null) : null;
  return {
    binary,
    endLine,
    file: { additions, deletions, path, previousPath, status },
    startLine,
  };
};

export interface BoundedReviewPatch {
  /** Every file section of the patch, in patch order, with its coverage; not bounded for listing. */
  readonly files: readonly (ReviewScopeFile & { readonly binary: boolean })[];
  readonly included: string;
  readonly includedBytes: number;
  readonly includedLines: number;
  readonly patchBytes: number;
  readonly patchLines: number;
  readonly truncated: boolean;
}

/**
 * Splits a `git diff-tree -p` patch into file sections and cuts it, at a line boundary, to the
 * budget. The included text is always a prefix of the patch, so its bytes and the patch's hash
 * identify it exactly.
 */
export const boundReviewPatch = (
  patch: string,
  limits: Pick<ReviewPatchLimits, 'maxPatchPromptBytes' | 'maxPatchPromptLines'>,
): BoundedReviewPatch => {
  const lines = patch.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let includedLines = 0;
  let includedBytes = 0;
  let patchBytes = 0;
  let open = true;
  for (const line of lines) {
    const bytes = byteLength(line);
    patchBytes += bytes;
    if (
      open &&
      includedBytes + bytes <= limits.maxPatchPromptBytes &&
      includedLines + 1 <= limits.maxPatchPromptLines
    ) {
      includedBytes += bytes;
      includedLines += 1;
    } else {
      open = false;
    }
  }
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith(DIFF_HEADER)) {
      starts.push(index);
    }
  }
  const files = starts.map((startLine, position) => {
    const section = readSection(lines, startLine, starts[position + 1] ?? lines.length);
    let coverage: ReviewScopeFile['coverage'];
    if (section.endLine <= includedLines) {
      coverage = section.binary ? 'binary' : 'complete';
    } else if (section.startLine < includedLines) {
      coverage = 'partial';
    } else {
      coverage = 'omitted';
    }
    return { ...section.file, binary: section.binary, coverage };
  });
  return {
    files,
    included: lines.slice(0, includedLines).join(''),
    includedBytes,
    includedLines,
    patchBytes,
    patchLines: lines.length,
    truncated: includedLines < lines.length,
  };
};

interface GitAnswer {
  readonly exitCode: number;
  readonly stdout: string;
}

const runGit = async (
  checkoutPath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  maximumOutputBytes: number,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitAnswer> => {
  try {
    return await executeBoundedProcess({
      args: [...GIT_GLOBAL_OPTIONS, ...args],
      command: 'git',
      cwd: checkoutPath,
      env: environment,
      maximumOutputBytes,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof BoundedProcessError) {
      if (error.kind === 'output-limit') {
        throw new ReviewScopeError('too-large', `git ${args[0]} answered more than ${maximumOutputBytes} bytes`);
      }
      if (error.kind === 'failed' && error.failure === 'undecodable') {
        throw new ReviewScopeError('not-text', `git ${args[0]} answered something that is not UTF-8 text`);
      }
      if (error.kind === 'failed') {
        throw new ReviewScopeError('git-failed', `git ${args[0]} ended without an exit code (killed by a signal)`);
      }
      throw new ReviewScopeError('git-failed', `git ${args[0]} ${error.kind}`);
    }
    throw error;
  }
};

const RAW_DIFF_ENTRY = /^:\d{6} \d{6} ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) /u;
const NULL_OBJECT = /^0+$/u;
/** Objects checked in one `rev-list` call; a larger comparison is checked on its first ones only. */
const MAX_CHECKED_OBJECTS = 4096;

/**
 * How many blobs the comparison needs that the object store does not hold, without fetching
 * any: the raw comparison reads trees only, and `rev-list --missing=print` names each absent
 * object with a leading `?`. Zero when the answer cannot be read (the caller then reports the
 * comparison as failed, not as a missing blob).
 */
const missingObjects = async (
  checkoutPath: string,
  environment: Readonly<Record<string, string>>,
  baseSha: string,
  headSha: string,
): Promise<number> => {
  try {
    const raw = await runGit(
      checkoutPath,
      ['diff-tree', '-r', '--raw', '--no-renames', '--no-commit-id', '--end-of-options', baseSha, headSha],
      environment,
      GIT_SMALL_OUTPUT_BYTES,
    );
    if (raw.exitCode !== 0) {
      return 0;
    }
    const blobs = new Set<string>();
    for (const line of raw.stdout.split('\n')) {
      const entry = RAW_DIFF_ENTRY.exec(line);
      for (const sha of entry === null ? [] : [entry[1], entry[2]]) {
        if (sha !== undefined && !NULL_OBJECT.test(sha) && blobs.size < MAX_CHECKED_OBJECTS) {
          blobs.add(sha);
        }
      }
    }
    if (blobs.size === 0) {
      return 0;
    }
    const listed = await runGit(
      checkoutPath,
      ['rev-list', '--objects', '--missing=print', '--no-walk', ...blobs],
      environment,
      GIT_SMALL_OUTPUT_BYTES,
    );
    return listed.exitCode === 0 ? listed.stdout.split('\n').filter((line) => line.startsWith('?')).length : 0;
  } catch (error) {
    // The check is a diagnosis of a failure already known; it never replaces that failure.
    if (error instanceof ReviewScopeError) {
      return 0;
    }
    throw error;
  }
};

const resolveHead = async (checkoutPath: string, environment: Readonly<Record<string, string>>): Promise<string> => {
  const answer = await runGit(
    checkoutPath,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
    environment,
    4096,
  );
  const sha = answer.stdout.trim();
  if (answer.exitCode !== 0 || !OBJECT_ID.test(sha)) {
    throw new ReviewScopeError('no-commit', 'the checkout has no commit to review (HEAD does not resolve to a commit)');
  }
  return sha;
};

/** Parents and subject from the raw commit object: no log formatting, no signature check, no configuration. */
const readCommit = (text: string): { readonly parents: readonly string[]; readonly subject: string | null } => {
  const separator = text.indexOf('\n\n');
  const header = separator < 0 ? text : text.slice(0, separator);
  const message = separator < 0 ? '' : text.slice(separator + 2);
  const parents = header
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim());
  const first =
    message
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim() ?? '';
  const subject = first.slice(0, REVIEW_ATTEMPT_BOUNDS.maxText);
  return { parents, subject: subject.length > 0 && isPrintableSkillObservationText(subject) ? subject : null };
};

const listable = (file: ReviewScopeFile): boolean =>
  file.path.length > 0 &&
  file.path.length <= REVIEW_ATTEMPT_BOUNDS.maxScopePath &&
  isPrintableSkillObservationText(file.path) &&
  (file.previousPath === null ||
    (file.previousPath.length <= REVIEW_ATTEMPT_BOUNDS.maxScopePath &&
      isPrintableSkillObservationText(file.previousPath)));

export const prepareReviewScope = async (
  checkoutPath: string,
  options: PrepareReviewScopeOptions = {},
): Promise<PreparedReviewScope> => {
  const limits: ReviewPatchLimits = {
    maxPatchPromptBytes: options.limits?.maxPatchPromptBytes ?? REVIEW_ATTEMPT_BOUNDS.maxPatchPromptBytes,
    maxPatchPromptLines: options.limits?.maxPatchPromptLines ?? REVIEW_ATTEMPT_BOUNDS.maxPatchPromptLines,
    maxPatchReadBytes: options.limits?.maxPatchReadBytes ?? REVIEW_ATTEMPT_BOUNDS.maxPatchReadBytes,
  };
  const environment = {
    ...boundedProcessEnvironment({}, options.env ?? process.env),
    ...GIT_SCOPE_ENVIRONMENT,
  };
  const headSha = await resolveHead(checkoutPath, environment);
  const prefix = await runGit(checkoutPath, ['rev-parse', '--show-prefix'], environment, 8192);
  if (prefix.exitCode !== 0) {
    throw new ReviewScopeError('git-failed', 'git rev-parse --show-prefix failed');
  }
  const commit = await runGit(checkoutPath, ['cat-file', 'commit', headSha], environment, GIT_SMALL_OUTPUT_BYTES);
  if (commit.exitCode !== 0) {
    throw new ReviewScopeError('git-failed', `git cat-file could not read commit ${headSha}`);
  }
  const { parents, subject } = readCommit(commit.stdout);
  const emptyTree = headSha.length === 40 ? GIT_EMPTY_TREE.sha1 : GIT_EMPTY_TREE.sha256;
  const baseSha = parents[0] ?? emptyTree;
  if (!OBJECT_ID.test(baseSha)) {
    throw new ReviewScopeError('git-failed', `commit ${headSha} names an unreadable parent`);
  }
  let patch: GitAnswer;
  try {
    patch = await runGit(
      checkoutPath,
      [...REVIEW_DIFF_TREE_OPTIONS, '--end-of-options', baseSha, headSha],
      environment,
      limits.maxPatchReadBytes,
      GIT_PATCH_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ReviewScopeError && error.kind === 'too-large') {
      throw new ReviewScopeError(
        'too-large',
        `the patch of commit ${headSha} exceeds ${limits.maxPatchReadBytes} bytes; review a smaller commit`,
      );
    }
    throw error;
  }
  if (patch.exitCode !== 0) {
    const absent = await missingObjects(checkoutPath, environment, baseSha, headSha);
    if (absent > 0) {
      throw new ReviewScopeError(
        'blob-not-local',
        `blob-not-local: ${absent} blob${absent === 1 ? '' : 's'} of commit ${headSha} or its base ${absent === 1 ? 'is' : 'are'} not in the local object store (partial clone); the review never fetches: fetch them yourself (git fetch) or review another checkout`,
      );
    }
    throw new ReviewScopeError('git-failed', `git diff-tree could not compare ${baseSha} and ${headSha}`);
  }
  const bounded = boundReviewPatch(patch.stdout, limits);
  if (bounded.files.length === 0) {
    throw new ReviewScopeError('empty', `commit ${headSha} changes no file against its base; nothing to review`);
  }
  if (bounded.files.every((file) => file.binary)) {
    throw new ReviewScopeError('binary-only', `commit ${headSha} changes only binary files; nothing textual to review`);
  }
  let workingTreeDirty: boolean;
  try {
    const status = await runGit(
      checkoutPath,
      ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty'],
      environment,
      GIT_SMALL_OUTPUT_BYTES,
    );
    if (status.exitCode !== 0) {
      throw new ReviewScopeError(
        'git-failed',
        'git status failed; whether the working tree matches the commit is unknown',
      );
    }
    workingTreeDirty = status.stdout.length > 0;
  } catch (error) {
    // More status than the bound means changes exist, and so does output that is not UTF-8 (a
    // changed file whose name is not): emptiness is the only fact needed here.
    if (error instanceof ReviewScopeError && (error.kind === 'too-large' || error.kind === 'not-text')) {
      workingTreeDirty = true;
    } else {
      throw error;
    }
  }
  await options.beforeHeadRecheck?.();
  const headAfter = await resolveHead(checkoutPath, environment);
  if (headAfter !== headSha) {
    throw new ReviewScopeError(
      'moved',
      `HEAD moved from ${headSha} to ${headAfter} while the review was prepared; start the review again`,
    );
  }
  const files = bounded.files.map(({ binary: _binary, ...file }) => file);
  const listed = files.filter(listable).slice(0, REVIEW_ATTEMPT_BOUNDS.maxScopeFiles);
  const scope = parseReviewAttemptScope({
    base: parents.length === 0 ? 'empty-tree' : 'first-parent',
    baseSha,
    fileCount: files.length,
    files: listed,
    headSha,
    includedBytes: bounded.includedBytes,
    includedLines: bounded.includedLines,
    kind: 'commit',
    parentCount: parents.length,
    patchBytes: bounded.patchBytes,
    patchLines: bounded.patchLines,
    patchSha256: createHash('sha256').update(patch.stdout, 'utf8').digest('hex'),
    repositoryPrefix: prefix.stdout.replace(TRAILING_NEWLINE, ''),
    subject,
    truncated: bounded.truncated,
    workingTreeDirty,
  } satisfies ReviewAttemptScope);
  if (scope === null) {
    throw new ReviewScopeError('git-failed', `the scope of commit ${headSha} does not satisfy its own contract`);
  }
  return { patch: bounded.included, scope };
};
