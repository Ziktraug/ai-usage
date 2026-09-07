export const DERIVED_SESSION_LABEL_MAX_CHARACTERS = 200;

const CONTEXT_BLOCK_PATTERN = /<context\b[^>]*>[\s\S]*?<\/context\s*>/giu;
// Harness-injected wrappers, never something the person typed: an attached image's placeholder
// (`<image name=[Image #1] path="…">`) and Claude Code's system reminders. Paired or self-closing.
const INJECTED_TAG_BLOCK_PATTERN = /<(image|system-reminder|attachment)\b[^>]*>(?:[\s\S]*?<\/\1\s*>)?/giu;
const TAGGED_LOG_BLOCK_PATTERN = /<(log|logs|console|terminal|output)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const BRACKETED_LOG_BLOCK_PATTERN =
  /\[(?:log|logs|console|terminal|output)\][\s\S]*?\[\/(?:log|logs|console|terminal|output)\]/giu;
const LOCAL_FILE_LINK_PATTERN = /\[@([^\]\r\n]+)\]\(file:\/\/\/[^)\r\n]+\)/giu;
const FENCED_BLOCK_PATTERN = /^([ \t]*)(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)^[ \t]*\2[ \t]*$/gimu;
const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/u;
const MARKDOWN_HEADING_PATTERN = /^\s{0,3}#{1,6}[ \t]+\S/u;
const LOG_FENCE_INFO_PATTERN = /(?:^|\s)(?:log|logs|console|terminal|output)(?:\s|$)/iu;
const ISO_LOG_LINE_PATTERN = /^\s*\[?\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?Z?\]?/u;
const LEVEL_LOG_LINE_PATTERN =
  /^\s*(?:\[(?:trace|debug|info|warn(?:ing)?|error|fatal)\]|(?:trace|debug|info|warn(?:ing)?|error|fatal)\b)/iu;
const JSON_LOG_LINE_PATTERN = /^\s*\{[^\r\n]*(?:"(?:level|timestamp|time|message)"\s*:)/iu;
const STACK_LOG_LINE_PATTERN = /^\s*(?:at\s+\S|Caused by:|[A-Za-z_$][\w.$]*(?:Error|Exception):)/u;
const FIRST_SENTENCE_PATTERN = /^.*?[.!?…](?=\s|$)/u;
const LINE_BREAK_PATTERN = /\r?\n/u;

const isStrongLogLine = (line: string): boolean =>
  ISO_LOG_LINE_PATTERN.test(line) || LEVEL_LOG_LINE_PATTERN.test(line) || JSON_LOG_LINE_PATTERN.test(line);

const isLogLine = (line: string): boolean => isStrongLogLine(line) || STACK_LOG_LINE_PATTERN.test(line);

const stripFencedLogBlocks = (value: string): string =>
  value.replace(
    FENCED_BLOCK_PATTERN,
    (block: string, _indent: string, _fence: string, info: string, body: string): string => {
      if (LOG_FENCE_INFO_PATTERN.test(info.trim())) {
        return '\n';
      }
      const lines = body.split(LINE_BREAK_PATTERN).filter((line) => line.trim().length > 0);
      const logLineCount = lines.filter(isLogLine).length;
      return lines.length >= 2 && logLineCount >= Math.ceil(lines.length / 2) ? '\n' : block;
    },
  );

const stripUnfencedLogLines = (value: string): string => {
  const lines = value.split(LINE_BREAK_PATTERN);
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!isStrongLogLine(line)) {
      kept.push(line);
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length) {
      const continuation = lines[index] ?? '';
      if (!(isLogLine(continuation) || continuation.trim().length === 0)) {
        break;
      }
      index += 1;
    }
  }
  return kept.join('\n');
};

const stripPastedLogBlocks = (value: string): string =>
  stripUnfencedLogLines(
    stripFencedLogBlocks(value).replace(TAGGED_LOG_BLOCK_PATTERN, '\n').replace(BRACKETED_LOG_BLOCK_PATTERN, '\n'),
  );

const firstLineBelowMarkdownHeading = (value: string): string | null => {
  const lines = value.split(LINE_BREAK_PATTERN);
  let activeFence: string | null = null;
  for (const [index, line] of lines.entries()) {
    const fence = line.match(FENCE_LINE_PATTERN)?.[1] ?? null;
    if (fence) {
      if (activeFence === null) {
        activeFence = fence[0] ?? null;
      } else if (fence.startsWith(activeFence)) {
        activeFence = null;
      }
      continue;
    }
    if (activeFence !== null || !MARKDOWN_HEADING_PATTERN.test(line)) {
      continue;
    }
    for (const candidate of lines.slice(index + 1)) {
      const trimmed = candidate.trim();
      if (!trimmed) {
        continue;
      }
      return MARKDOWN_HEADING_PATTERN.test(trimmed) ? null : trimmed;
    }
    return null;
  }
  return null;
};

const firstSentence = (value: string): string => {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.match(FIRST_SENTENCE_PATTERN)?.[0] ?? normalized;
};

const boundLabel = (value: string): string | null => {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return null;
  }
  const characters = [...normalized];
  if (characters.length <= DERIVED_SESSION_LABEL_MAX_CHARACTERS) {
    return normalized;
  }
  const prefix = characters
    .slice(0, DERIVED_SESSION_LABEL_MAX_CHARACTERS - 1)
    .join('')
    .trimEnd();
  return `${prefix}…`;
};

export const deriveSessionLabelFromPrompt = (prompt: string | null | undefined): string | null => {
  if (!prompt) {
    return null;
  }
  const withoutContext = prompt.replace(CONTEXT_BLOCK_PATTERN, '\n').replace(INJECTED_TAG_BLOCK_PATTERN, '\n');
  const withoutLogs = stripPastedLogBlocks(withoutContext);
  const withReadableFileLinks = withoutLogs.replace(LOCAL_FILE_LINK_PATTERN, '@$1');
  const headingLine = firstLineBelowMarkdownHeading(withReadableFileLinks);
  return boundLabel(headingLine ?? firstSentence(withReadableFileLinks));
};
