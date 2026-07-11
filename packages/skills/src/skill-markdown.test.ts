import { describe, expect, test } from 'bun:test';
import { parseSkillMarkdown } from '.';

describe('skill markdown parsing', () => {
  test('parses valid frontmatter and markdown', () => {
    const result = parseSkillMarkdown(
      'example-skill',
      `---
name: example-skill
description: Helps with examples
paths:
  - references/**
disable-model-invocation: true
---
# Example Skill
`,
    );

    expect(result.manifest.name).toBe('example-skill');
    expect(result.manifest.description).toBe('Helps with examples');
    expect(result.manifest.fields.map((field) => [field.key, field.kind])).toEqual([
      ['name', 'standard'],
      ['description', 'standard'],
      ['paths', 'known-extension'],
      ['disable-model-invocation', 'known-extension'],
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('reports missing description and name mismatch', () => {
    const result = parseSkillMarkdown(
      'expected-skill',
      `---
name: other-skill
---
# Expected Skill
`,
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'MissingSkillDescription',
      'SkillNameMismatch',
    ]);
  });

  test('warns on unknown frontmatter fields', () => {
    const result = parseSkillMarkdown(
      'example-skill',
      `---
name: example-skill
description: Helps with examples
custom-value: yes
---
# Example Skill
`,
    );

    expect(result.manifest.fields.at(-1)).toEqual({
      key: 'custom-value',
      kind: 'unknown-extension',
      value: 'yes',
    });
    expect(result.diagnostics[0]?.code).toBe('UnknownFrontmatterField');
  });
});
