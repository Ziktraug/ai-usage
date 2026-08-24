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

  test('accepts documented Claude Code and Agent Skills frontmatter without diagnostics', () => {
    const result = parseSkillMarkdown(
      'example-skill',
      `---
name: example-skill
description: Helps with examples
agent: Explore
allowed-tools:
  - Read
argument-hint: [path]
arguments:
  - path
background: false
compatibility: Requires git
context: fork
disable-model-invocation: true
disallowed-tools:
  - AskUserQuestion
effort: high
hooks:
  PreToolUse: configured
license: MIT
metadata:
  author: example
model: inherit
paths:
  - references/**
shell: bash
user-invocable: false
when_to_use: Use for examples
---
# Example Skill
`,
    );

    expect(result.diagnostics).toEqual([]);
    expect(
      result.manifest.fields
        .filter((field) => !['description', 'name'].includes(field.key))
        .map((field) => [field.key, field.kind]),
    ).toEqual([
      ['agent', 'known-extension'],
      ['allowed-tools', 'known-extension'],
      ['argument-hint', 'known-extension'],
      ['arguments', 'known-extension'],
      ['background', 'known-extension'],
      ['compatibility', 'known-extension'],
      ['context', 'known-extension'],
      ['disable-model-invocation', 'known-extension'],
      ['disallowed-tools', 'known-extension'],
      ['effort', 'known-extension'],
      ['hooks', 'known-extension'],
      ['license', 'known-extension'],
      ['metadata', 'known-extension'],
      ['model', 'known-extension'],
      ['paths', 'known-extension'],
      ['shell', 'known-extension'],
      ['user-invocable', 'known-extension'],
      ['when_to_use', 'known-extension'],
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
