import { describe, expect, test } from 'bun:test';
import { modelGroupKey, parseModelIdentity } from './model-identity';

describe('model identity', () => {
  test('canonicalizes provider-prefixed model ids without changing the raw id', () => {
    expect(parseModelIdentity('openai/gpt-5.5')).toEqual({
      rawId: 'openai/gpt-5.5',
      canonicalId: 'gpt-5.5',
      baseId: 'gpt-5.5',
      providerPrefix: 'openai',
      variantTags: [],
    });
    expect(modelGroupKey('cursor/gpt-5.4-high', 'exact')).toBe('gpt-5.4-high');
  });

  test('rolls model mode suffixes up to a base model id', () => {
    expect(modelGroupKey('gpt-5.4-high')).toBe('gpt-5.4');
    expect(modelGroupKey('gpt-5.1-codex-max-xhigh-fast')).toBe('gpt-5.1-codex');
    expect(modelGroupKey('claude-4.5-opus-high-thinking')).toBe('claude-4.5-opus');
    expect(modelGroupKey('claude-opus-4-7-thinking-high')).toBe('claude-opus-4-7');
  });

  test('keeps product tiers that are not mode suffixes', () => {
    expect(modelGroupKey('gpt-5-codex')).toBe('gpt-5-codex');
    expect(modelGroupKey('gpt-5-pro')).toBe('gpt-5-pro');
    expect(modelGroupKey('opencode/glm-5-free')).toBe('glm-5-free');
  });

  test('tracks stripped variant tags in order', () => {
    expect(parseModelIdentity('gpt-5.1-codex-max-xhigh-fast').variantTags).toEqual(['max', 'xhigh', 'fast']);
    expect(parseModelIdentity('gemini-3-pro-preview').variantTags).toEqual(['preview']);
    expect(parseModelIdentity('gemini-2.5-pro-preview-06-05').baseId).toBe('gemini-2.5-pro');
  });
});
