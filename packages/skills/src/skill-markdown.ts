import type {
  JsonValue,
  ParsedSkillMarkdown,
  SkillDiagnostic,
  SkillFrontmatterField,
  SkillFrontmatterFieldKind,
  SkillManifest,
  SkillValidationStatus,
} from './contracts';
import { createDiagnostic } from './diagnostics';
import { parseSkillName, skillTokenDiagnosticCodes } from './shared';

const frontmatterClosePattern = /^\n---\r?\n?/;
const lineBreakPattern = /\r?\n/;
const whitespacePattern = /\s+/;
const knownFrontmatterExtensions = new Set(['paths', 'disable-model-invocation']);
const standardFrontmatterFields = new Set(['name', 'description']);
const tokenDiagnosticCodeSet = new Set<string>(skillTokenDiagnosticCodes);

export const approximateTokenCount = (text: string): number => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return Math.ceil(trimmed.split(whitespacePattern).length * 1.35);
};

export const looksBinary = (buffer: Buffer): boolean => buffer.includes(0);

const parseScalarFrontmatterValue = (value: string): JsonValue => {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const classifyFrontmatterField = (key: string): SkillFrontmatterFieldKind => {
  if (standardFrontmatterFields.has(key)) {
    return 'standard';
  }
  if (knownFrontmatterExtensions.has(key)) {
    return 'known-extension';
  }
  return 'unknown-extension';
};

const parseFrontmatter = (text: string) => {
  if (!text.startsWith('---\n')) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const endIndex = text.indexOf('\n---', 4);
  if (endIndex === -1) {
    return { fields: [] as SkillFrontmatterField[], markdown: text };
  }

  const frontmatter = text.slice(4, endIndex);
  const markdown = text.slice(endIndex).replace(frontmatterClosePattern, '');
  const lines = frontmatter.split(lineBreakPattern);
  const fields: SkillFrontmatterField[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0 || line.startsWith(' ')) {
      continue;
    }
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    let value: JsonValue = parseScalarFrontmatterValue(rawValue);
    if (rawValue.length === 0) {
      const arrayValue: string[] = [];
      while (lines[index + 1]?.trim().startsWith('- ')) {
        index += 1;
        const item = lines[index]?.trim().slice(2).trim();
        if (item) {
          arrayValue.push(item);
        }
      }
      value = arrayValue;
    }
    fields.push({
      key,
      kind: classifyFrontmatterField(key),
      value,
    });
  }

  return { fields, markdown };
};

const textField = (fields: readonly SkillFrontmatterField[], key: string): string | undefined => {
  const field = fields.find((entry) => entry.key === key);
  return typeof field?.value === 'string' && field.value.trim().length > 0 ? field.value : undefined;
};

export const validationStatusFor = (diagnostics: readonly SkillDiagnostic[]): SkillValidationStatus => {
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === 'error' && !tokenDiagnosticCodeSet.has(diagnostic.code))
  ) {
    return 'invalid';
  }
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === 'warning' || tokenDiagnosticCodeSet.has(diagnostic.code))
  ) {
    return 'warning';
  }
  return 'valid';
};

export const parseSkillMarkdown = (skillName: string, text: string): ParsedSkillMarkdown => {
  const parsedSkillName = parseSkillName(skillName);
  const { fields, markdown } = parseFrontmatter(text);
  const manifestName = textField(fields, 'name');
  const description = textField(fields, 'description');
  const diagnostics: SkillDiagnostic[] = [];

  if (description === undefined) {
    diagnostics.push(
      createDiagnostic('MissingSkillDescription', 'warning', 'SKILL.md frontmatter should include description', {
        skillName: parsedSkillName,
      }),
    );
  }
  if (manifestName !== undefined && manifestName !== parsedSkillName) {
    diagnostics.push(
      createDiagnostic('SkillNameMismatch', 'error', 'SKILL.md frontmatter name does not match directory name', {
        skillName: parsedSkillName,
      }),
    );
  }
  for (const field of fields) {
    if (field.kind === 'unknown-extension') {
      diagnostics.push(
        createDiagnostic('UnknownFrontmatterField', 'warning', `Unknown SKILL.md frontmatter field: ${field.key}`, {
          skillName: parsedSkillName,
        }),
      );
    }
  }

  const manifest: SkillManifest = {
    fields,
    markdown,
  };
  if (manifestName !== undefined) {
    manifest.name = manifestName;
  }
  if (description !== undefined) {
    manifest.description = description;
  }
  return { diagnostics, manifest };
};
