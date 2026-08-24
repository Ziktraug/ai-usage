import { describe, expect, test } from 'bun:test';
import type { SkillMarkdownDocument, SkillMarkdownSaveResult } from '@ai-usage/web-contract/skills';
import type { SkillsClientResult } from '../../../rpc/skills-client';
import { createSkillMarkdownEditorController, isSkillMarkdownSaveShortcut } from './controller';

const document = (
  content = '# Alpha\n',
  sha256 = 'a'.repeat(64),
  skillName = 'alpha-skill',
): SkillMarkdownDocument => ({
  content,
  path: `/synthetic/${skillName}/SKILL.md`,
  sha256,
  skillName,
});

const dependencies = (
  overrides: {
    readonly loadMarkdown?: (skillName: string) => Promise<SkillsClientResult<SkillMarkdownDocument>>;
    readonly onSaved?: (skillName: string, result: SkillsClientResult<SkillMarkdownSaveResult>) => void;
    readonly saveMarkdown?: () => Promise<SkillsClientResult<SkillMarkdownSaveResult>>;
  } = {},
) => ({
  loadMarkdown:
    overrides.loadMarkdown ??
    ((skillName: string) => Promise.resolve({ data: document('# Refreshed\n', 'b'.repeat(64), skillName), ok: true })),
  onSaved: overrides.onSaved ?? (() => undefined),
  saveMarkdown:
    overrides.saveMarkdown ??
    (() =>
      Promise.resolve({
        data: { document: document('# Saved\n', 'c'.repeat(64)), snapshot: {} },
        ok: true,
      }) as Promise<SkillsClientResult<SkillMarkdownSaveResult>>),
});

describe('Svelte Skills markdown editor controller', () => {
  test('edits immediately and preserves follow-up input while a save is in flight', async () => {
    const pending = Promise.withResolvers<SkillsClientResult<SkillMarkdownSaveResult>>();
    const saved: string[] = [];
    const controller = createSkillMarkdownEditorController(
      dependencies({
        onSaved: (skillName) => saved.push(skillName),
        saveMarkdown: () => pending.promise,
      }),
      document(),
    );

    controller.setDraft('# Submitted\n');
    const save = controller.save();
    controller.setDraft('# Follow-up\n');
    pending.resolve({
      data: {
        document: document('# Submitted\n', 'b'.repeat(64)),
        snapshot: {} as never,
      },
      ok: true,
    });
    await save;

    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: { content: '# Submitted\n' },
      draft: '# Follow-up\n',
      message: 'SKILL.md saved; newer edits remain unsaved.',
      saving: false,
    });
    expect(saved).toEqual(['alpha-skill']);
  });

  test('retains the exact draft on conflict, save failure, and a changed disk refresh', async () => {
    let saveResult: SkillsClientResult<SkillMarkdownSaveResult> = {
      data: { reason: 'conflict' },
      ok: true,
    };
    const controller = createSkillMarkdownEditorController(
      dependencies({
        loadMarkdown: () => Promise.resolve({ data: document('# Disk changed\n', 'd'.repeat(64)), ok: true }),
        saveMarkdown: () => Promise.resolve(saveResult),
      }),
      document('# Stored\n'),
    );
    const exactDraft = '# Exact local draft\n\nKeep this.\n';
    controller.setDraft(exactDraft);

    await controller.save();
    expect(controller.getState()).toMatchObject({
      conflict: true,
      dirty: true,
      draft: exactDraft,
      message: 'Changed on disk',
    });

    controller.discardDraft();
    controller.setDraft(exactDraft);
    saveResult = { error: { message: 'Storage unavailable', tag: 'Unavailable' }, ok: false };
    await controller.save();
    expect(controller.getState()).toMatchObject({ dirty: true, draft: exactDraft, message: 'Storage unavailable' });

    await controller.refresh();
    expect(controller.getState()).toMatchObject({
      conflict: true,
      dirty: true,
      document: { content: '# Stored\n' },
      draft: exactDraft,
      message: 'Changed on disk',
    });
    controller.discardDraft();
    expect(controller.getState()).toMatchObject({
      conflict: false,
      dirty: false,
      document: { content: '# Disk changed\n' },
      draft: '# Disk changed\n',
    });
  });

  test('gives a dirty draft priority over a different selection', () => {
    const controller = createSkillMarkdownEditorController(dependencies(), document());
    controller.setDraft('# Keep alpha\n');

    expect(controller.acceptDocument(document('# Beta\n', 'b'.repeat(64), 'beta-skill'))).toBe('blocked');
    expect(controller.getState()).toMatchObject({
      dirty: true,
      draft: '# Keep alpha\n',
      skillName: 'alpha-skill',
    });
  });

  test('preserves the exact draft when the shell resynchronizes the same document identity', () => {
    const initial = document('# Stored\n');
    const controller = createSkillMarkdownEditorController(dependencies(), initial);
    controller.setDraft('# Exact retained draft\n');

    expect(controller.acceptDocument({ ...initial })).toBe('accepted');
    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: { content: '# Stored\n' },
      draft: '# Exact retained draft\n',
    });
  });

  test('preserves a save notice only while resynchronizing the just-saved revision', async () => {
    const controller = createSkillMarkdownEditorController(dependencies(), document());
    controller.setDraft('# Saved\n');
    await controller.save();

    expect(controller.acceptDocument(document('# Saved\n', 'c'.repeat(64)))).toBe('accepted');
    expect(controller.getState().message).toBe('SKILL.md saved.');

    expect(controller.acceptDocument(document('# External\n', 'd'.repeat(64)))).toBe('accepted');
    expect(controller.getState()).toMatchObject({ document: { content: '# External\n' }, message: null });
  });

  test('clears a save notice when another skill has the same revision hash', async () => {
    const controller = createSkillMarkdownEditorController(dependencies(), document());
    controller.setDraft('# Saved\n');
    await controller.save();

    expect(controller.acceptDocument(document('# Saved\n', 'c'.repeat(64), 'beta-skill'))).toBe('accepted');
    expect(controller.getState()).toMatchObject({
      document: { skillName: 'beta-skill' },
      message: null,
      skillName: 'beta-skill',
    });
  });

  test('ignores a stale refresh after a newer document is accepted', async () => {
    const pending = Promise.withResolvers<SkillsClientResult<SkillMarkdownDocument>>();
    const controller = createSkillMarkdownEditorController(
      dependencies({ loadMarkdown: () => pending.promise }),
      document(),
    );

    const refresh = controller.refresh();
    expect(controller.acceptDocument(document('# Beta\n', 'b'.repeat(64), 'beta-skill'))).toBe('accepted');
    pending.resolve({ data: document('# Stale alpha\n', 'c'.repeat(64)), ok: true });
    await refresh;

    expect(controller.getState()).toMatchObject({
      document: { content: '# Beta\n', skillName: 'beta-skill' },
      draft: '# Beta\n',
      loading: false,
      skillName: 'beta-skill',
    });
  });

  test('keeps an exact conflict draft when disk replacement supersedes an in-flight save', async () => {
    const pending = Promise.withResolvers<SkillsClientResult<SkillMarkdownSaveResult>>();
    const controller = createSkillMarkdownEditorController(
      dependencies({ saveMarkdown: () => pending.promise }),
      document('# Stored\n'),
    );
    const exactDraft = '# Exact pending save\n';
    controller.setDraft(exactDraft);
    const save = controller.save();

    expect(controller.acceptDocument(document('# Disk replacement\n', 'd'.repeat(64)))).toBe('conflict');
    pending.resolve({
      data: {
        document: document(exactDraft, 'e'.repeat(64)),
        snapshot: {} as never,
      },
      ok: true,
    });
    await save;

    expect(controller.getState()).toMatchObject({
      conflict: true,
      dirty: true,
      document: { content: '# Stored\n' },
      draft: exactDraft,
      message: 'Changed on disk',
      saving: false,
    });
  });

  test('recognizes Ctrl+S and Command+S without intercepting another key', () => {
    expect(isSkillMarkdownSaveShortcut({ ctrlKey: true, key: 's', metaKey: false })).toBe(true);
    expect(isSkillMarkdownSaveShortcut({ ctrlKey: false, key: 'S', metaKey: true })).toBe(true);
    expect(isSkillMarkdownSaveShortcut({ ctrlKey: true, key: 'r', metaKey: false })).toBe(false);
  });
});
