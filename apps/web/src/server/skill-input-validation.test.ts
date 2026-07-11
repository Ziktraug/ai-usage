import { expect, test } from 'bun:test';
import { skillNameInputForClient, targetIdInputForClient } from './skill-input-validation';

test('client skill-name validation rejects numeric-leading names consistently with the domain', () => {
  expect(() => skillNameInputForClient('1-example-skill')).toThrow('skill name');
  expect(skillNameInputForClient('example-skill-1')).toBe('example-skill-1');
});

test('client target-id validation rejects numeric-leading ids consistently with the domain', () => {
  expect(() => targetIdInputForClient('1-codex')).toThrow('target id');
  expect(targetIdInputForClient('codex-1')).toBe('codex-1');
});
