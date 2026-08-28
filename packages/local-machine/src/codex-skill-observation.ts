import {
  MAX_SKILL_OBSERVATION_PATH_LENGTH,
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  parseSkillObservation,
  type SkillObservation,
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
 */
const CODEX_CATALOGUE_ENTRY = /^[ \t]*-[ \t]+([A-Za-z0-9][\w.-]*)[ \t]*:[ \t]*(.*)$/;
const CODEX_CATALOGUE_LOCATION = /\((?:file|path):[ \t]*([^)]+)\)[ \t]*$/;
const CODEX_CATALOGUE_SECTION_BREAK = /^#{1,6}[ \t]/;

/** A shell command that reads a skill document, e.g. `sed -n 1,240p …/foo/SKILL.md`. */
const CODEX_SKILL_DOCUMENT_PATH = /(\S*?skills\/([A-Za-z0-9][\w.-]*)\/SKILL\.md)/g;

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
): SkillObservation[] => {
  const observations: SkillObservation[] = [];
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
    }
  }
  return observations;
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
): SkillObservation[] => codexSkillExecObservations(matchCodexSkillDocuments(command), callId, context);

/**
 * The name-and-directory half of the exec matcher, split out so a streaming
 * parser can run it per line and retain only the match — never the command
 * string, which is unbounded and carries whatever the model typed.
 */
export const matchCodexSkillDocuments = (command: unknown): CodexSkillCatalogueEntry[] => {
  if (typeof command !== 'string' || !command.includes('SKILL.md')) {
    return [];
  }
  const entries: CodexSkillCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const matched of command.matchAll(CODEX_SKILL_DOCUMENT_PATH)) {
    if (entries.length >= MAX_SKILL_OBSERVATIONS_PER_SESSION) {
      break;
    }
    const documentPath = matched[1];
    const name = matched[2];
    if (!(documentPath && name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    entries.push({ name, path: codexSkillDirectory(documentPath) });
  }
  return entries;
};

/** Project matched skill documents into `inferred` observations. */
export const codexSkillExecObservations = (
  entries: readonly CodexSkillCatalogueEntry[],
  callId: string,
  context: CodexSkillObservationContext,
): SkillObservation[] => {
  const observations: SkillObservation[] = [];
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
    }
  }
  return observations;
};
