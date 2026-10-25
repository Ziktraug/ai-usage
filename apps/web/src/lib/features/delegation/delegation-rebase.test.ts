import { describe, expect, test } from 'bun:test';
import { modelEntryDraftFrom, newModelEntryDraft, newRuleDraft, ruleDraftFrom } from './delegation-model';
import { rebaseDraft, sameDraft } from './delegation-rebase';
import { SYNTHETIC_DELEGATION_SETTINGS } from './delegation-synthetic';

const settings = SYNTHETIC_DELEGATION_SETTINGS;
const [opus] = settings.models;
const [restrictRule, requireRule] = settings.delegation.config.rules;
if (!(opus && restrictRule && requireRule)) {
  throw new Error('The synthetic settings must declare a model and two rules.');
}

/** A model entry as another client would have saved it: the same declaration, dated at its save. */
const codexEntry = {
  alias: null,
  declaredAt: '2026-10-25T11:00:00.000Z',
  discouragedFor: [],
  harnesses: ['codex' as const],
  id: 'gpt-5-codex',
  nativeId: 'gpt-5-codex',
  note: null,
  provider: 'openai' as const,
  recommendedFor: ['tests' as const],
  resolvedVersion: null,
};

describe('rebaseDraft on a list of model entries', () => {
  const base = () => [modelEntryDraftFrom(opus.entry), modelEntryDraftFrom(codexEntry)];

  test('keeps my edit and takes the external one when they touch different entries', () => {
    const mine = base();
    mine[0] = { ...mine[0]!, note: 'My note on Opus' };
    const theirs = base();
    theirs[1] = modelEntryDraftFrom({ ...codexEntry, alias: 'codex', declaredAt: '2026-10-25T12:00:00.000Z' });

    const rebased = rebaseDraft(base(), mine, theirs);
    expect(rebased.conflicts).toEqual([]);
    expect(rebased.draft.map((entry) => [entry.id, entry.note, entry.alias])).toEqual([
      ['claude-opus-4-1', 'My note on Opus', 'Opus 4.1'],
      ['gpt-5-codex', '', 'codex'],
    ]);
    // The entry an external save re-dated keeps the latest view (its declaredAt), not my base's.
    expect(rebased.draft[1]?.original?.declaredAt).toBe('2026-10-25T12:00:00.000Z');
    expect(sameDraft(rebased.draft, theirs)).toBe(false);
  });

  test('names a field both sides changed, keeps the latest value and re-applies the rest', () => {
    const mine = base();
    mine[1] = { ...mine[1]!, alias: 'mine', note: 'Only I changed the note' };
    const theirs = base();
    theirs[1] = { ...theirs[1]!, alias: 'theirs' };

    const rebased = rebaseDraft(base(), mine, theirs);
    expect(rebased.conflicts).toEqual([{ mine: '"mine"', path: 'model/gpt-5-codex › alias', theirs: '"theirs"' }]);
    expect(rebased.draft[1]).toMatchObject({ alias: 'theirs', note: 'Only I changed the note' });
  });

  test('carries my additions and removals; an entry changed elsewhere survives my removal, and vice versa', () => {
    const added = { ...newModelEntryDraft('new-model-1'), id: 'o3', nativeId: 'o3', provider: 'openai' as const };
    const mine = [base()[0]!, added]; // I removed gpt-5-codex and added o3.
    const untouched = rebaseDraft(base(), mine, base());
    expect(untouched.conflicts).toEqual([]);
    expect(untouched.draft.map((entry) => entry.id)).toEqual(['claude-opus-4-1', 'o3']);

    const theirs = base();
    theirs[1] = { ...theirs[1]!, alias: 'kept elsewhere' };
    const changedElsewhere = rebaseDraft(base(), mine, theirs);
    expect(changedElsewhere.conflicts).toEqual([{ mine: 'removed', path: 'model/gpt-5-codex', theirs: 'changed' }]);
    expect(changedElsewhere.draft.map((entry) => entry.id)).toEqual(['claude-opus-4-1', 'gpt-5-codex', 'o3']);

    const editedButRemovedElsewhere = base();
    editedButRemovedElsewhere[1] = { ...editedButRemovedElsewhere[1]!, note: 'my edit' };
    const removedElsewhere = rebaseDraft(base(), editedButRemovedElsewhere, [base()[0]!]);
    expect(removedElsewhere.conflicts).toEqual([{ mine: 'changed', path: 'model/gpt-5-codex', theirs: 'removed' }]);
    expect(removedElsewhere.draft.map((entry) => entry.id)).toEqual(['claude-opus-4-1']);
  });

  test('an untouched draft follows the latest exactly; a draft equal to the latest has nothing to re-apply', () => {
    const theirs = base();
    theirs[0] = { ...theirs[0]!, note: 'external' };
    expect(rebaseDraft(base(), base(), theirs)).toEqual({ conflicts: [], draft: theirs });
    const mine = base();
    mine[0] = { ...mine[0]!, note: 'external' };
    expect(rebaseDraft(base(), mine, theirs)).toEqual({ conflicts: [], draft: theirs });
  });
});

describe('rebaseDraft on the rules form (records, lists and string lists together)', () => {
  const base = () => ({
    defaults: { identityEvidence: 'declared' as const, maxAttempts: '2', reservePercent: '20' },
    harnessOrder: 'claude-code' as const,
    preferences: { harnesses: ['claude-code' as const], models: 'claude-opus-4-1', nearResetMinutes: '' },
    rules: [ruleDraftFrom(restrictRule), ruleDraftFrom(requireRule)],
  });

  test('merges field by field across the record and words list and boolean conflicts', () => {
    const mine = base();
    mine.defaults.reservePercent = '30';
    mine.rules[0] = { ...mine.rules[0]!, routes: { ...mine.rules[0]!.routes, contexts: ['personal'] } };
    mine.rules.push({ ...newRuleDraft('new-rule-1'), effect: 'forbid', id: 'mine-new' });
    const theirs = base();
    theirs.defaults.maxAttempts = '3';
    theirs.rules[0] = { ...theirs.rules[0]!, routes: { ...theirs.rules[0]!.routes, contexts: [] } };

    const rebased = rebaseDraft(base(), mine, theirs);
    expect(rebased.conflicts).toEqual([
      { mine: 'personal', path: 'rules › rule/work-repos-professional › routes › contexts', theirs: '(none)' },
    ]);
    expect(rebased.draft.defaults).toEqual({ identityEvidence: 'declared', maxAttempts: '3', reservePercent: '30' });
    expect(rebased.draft.rules.map((rule) => rule.id)).toEqual([
      'work-repos-professional',
      'observed-identity-everywhere',
      'mine-new',
    ]);
    expect(rebased.draft.rules[0]?.routes.contexts).toEqual([]);
  });
});
