import { describe, expect, test } from 'bun:test';
import {
  createSkillMarkdownEditorController,
  runSkillMarkdownEditorAction,
  type SkillMarkdownDocumentResult,
  type SkillMarkdownSaveResult,
} from './skill-markdown-editor-model';

const documentResult = (
  skillName: string,
  content = `# ${skillName}\n`,
): Extract<SkillMarkdownDocumentResult, { ok: true }> => ({
  data: {
    content,
    path: `/skills/${skillName}/SKILL.md`,
    sha256: skillName.padEnd(64, '0'),
    skillName,
  },
  ok: true,
});

const deferred = <T>() => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
};

describe('skill markdown editor controller', () => {
  test('accepts draft input as soon as a document is loaded', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Immediate draft\n');

    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: { content: '# alpha-skill\n' },
      draft: '# Immediate draft\n',
    });
  });

  test('keeps a successfully saved document ready for another immediate edit', async () => {
    const saves: { baseSha256: string; content: string; skillName: string }[] = [];
    const savedDocument = {
      ...documentResult('alpha-skill', '# Server-confirmed edit\n').data,
      sha256: 'f'.repeat(64),
    };
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (input) => {
        saves.push(input);
        return Promise.resolve({ data: { document: savedDocument }, ok: true });
      },
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Local edit\n');
    await controller.save();

    expect(saves).toEqual([
      {
        baseSha256: documentResult('alpha-skill').data.sha256,
        content: '# Local edit\n',
        skillName: 'alpha-skill',
      },
    ]);
    expect(controller.getState()).toMatchObject({
      dirty: false,
      document: savedDocument,
      draft: '# Server-confirmed edit\n',
      saving: false,
    });

    controller.setDraft('# Second edit\n');

    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: savedDocument,
      draft: '# Second edit\n',
      message: null,
    });
  });

  test('does not call saveMarkdown for a clean document', async () => {
    let saveCalls = 0;
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => {
        saveCalls += 1;
        return Promise.resolve({ data: {}, ok: true });
      },
    });

    await controller.select('alpha-skill');
    await controller.save();

    expect(saveCalls).toBe(0);
    expect(controller.getState()).toMatchObject({ dirty: false, saving: false });
  });

  test('reverts the draft to the latest server-confirmed content without filesystem IO', async () => {
    const savedDocument = {
      ...documentResult('alpha-skill', '# Server-confirmed edit\n').data,
      sha256: 'f'.repeat(64),
    };
    let loadCalls = 0;
    let saveCalls = 0;
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => {
        loadCalls += 1;
        return Promise.resolve(documentResult(skillName));
      },
      saveMarkdown: () => {
        saveCalls += 1;
        return Promise.resolve({ data: { document: savedDocument }, ok: true });
      },
    });

    await controller.select('alpha-skill');
    controller.setDraft('# First local edit\n');
    await controller.save();
    controller.setDraft('# Discard this edit\n');
    controller.reportUnexpectedError(new Error('transient failure'));

    controller.revertDraft();

    expect(controller.getState()).toMatchObject({
      dirty: false,
      document: savedDocument,
      draft: '# Server-confirmed edit\n',
      message: null,
    });
    expect({ loadCalls, saveCalls }).toEqual({ loadCalls: 1, saveCalls: 1 });
  });

  test('preserves the exact local draft and exposes an explicit conflict state', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName, '# Server content\n')),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: { reason: 'conflict' }, ok: true }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Exact local draft\n\nDo not discard.\n');
    await controller.save();

    expect(controller.getState()).toMatchObject({
      conflict: true,
      dirty: true,
      document: { content: '# Server content\n', skillName: 'alpha-skill' },
      draft: '# Exact local draft\n\nDo not discard.\n',
      message: 'Changed on disk',
      saving: false,
    });

    controller.revertDraft();

    expect(controller.getState()).toMatchObject({
      conflict: true,
      dirty: false,
      draft: '# Server content\n',
      message: null,
    });
  });

  test('preserves the document and exact draft after another save failure', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName, '# Server content\n')),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> =>
        Promise.resolve({ error: { message: 'Storage unavailable', tag: 'storage-error' }, ok: false }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Exact local draft\n');
    await controller.save();

    expect(controller.getState()).toMatchObject({
      conflict: false,
      dirty: true,
      document: { content: '# Server content\n', skillName: 'alpha-skill' },
      draft: '# Exact local draft\n',
      message: 'Storage unavailable',
      saving: false,
    });
  });

  test('keeps a draft dirty when a save response omits the confirmed document', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName, '# Server content\n')),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Exact local draft\n');
    await controller.save();

    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: { content: '# Server content\n', skillName: 'alpha-skill' },
      draft: '# Exact local draft\n',
      message: 'Could not save SKILL.md: server returned no document.',
      saving: false,
    });
  });

  test('surfaces an unexpected async action failure in the visible editor state', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    await controller.select('alpha-skill');
    await runSkillMarkdownEditorAction(controller, () => Promise.reject(new Error('unexpected editor failure')));

    expect(controller.getState()).toMatchObject({
      message: 'unexpected editor failure',
      saving: false,
    });
  });

  test('preserves a dirty draft until selection changes are explicitly allowed', async () => {
    const saves: { content: string; skillName: string }[] = [];
    const loads: string[] = [];
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => {
        loads.push(skillName);
        return Promise.resolve(documentResult(skillName));
      },
      saveMarkdown: (input) => {
        saves.push({ content: input.content, skillName: input.skillName });
        return Promise.resolve({ data: { document: documentResult(input.skillName, input.content).data }, ok: true });
      },
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Unsaved alpha draft\n');

    const blockedSelection = await controller.select('beta-skill');

    expect(controller.getState()).toMatchObject({
      dirty: true,
      document: { skillName: 'alpha-skill' },
      draft: '# Unsaved alpha draft\n',
      skillName: 'alpha-skill',
    });
    expect(blockedSelection).toBe(false);
    expect(loads).toEqual(['alpha-skill']);
    expect(saves).toEqual([]);

    controller.revertDraft();
    const allowedSelection = await controller.select('beta-skill');

    expect(allowedSelection).toBe(true);
    expect(controller.getState()).toMatchObject({
      dirty: false,
      document: { skillName: 'beta-skill' },
      draft: '# beta-skill\n',
      skillName: 'beta-skill',
    });
  });

  test('reloads the selected document only after a dirty draft is discarded', async () => {
    let content = '# Original\n';
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName, content)),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Local draft\n');
    content = '# Changed on disk\n';

    expect(await controller.reload()).toBe(false);
    expect(controller.getState()).toMatchObject({
      dirty: true,
      draft: '# Local draft\n',
      document: { content: '# Original\n' },
    });

    controller.revertDraft();
    expect(await controller.reload()).toBe(true);
    expect(controller.getState()).toMatchObject({
      dirty: false,
      draft: '# Changed on disk\n',
      document: { content: '# Changed on disk\n' },
    });
  });

  test('ignores a stale load that finishes after a newer selection', async () => {
    const alphaLoad = deferred<SkillMarkdownDocumentResult>();
    const betaLoad = deferred<SkillMarkdownDocumentResult>();
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => (skillName === 'alpha-skill' ? alphaLoad.promise : betaLoad.promise),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    const alphaSelection = controller.select('alpha-skill');
    const betaSelection = controller.select('beta-skill');
    betaLoad.resolve(documentResult('beta-skill'));
    await betaSelection;
    alphaLoad.resolve(documentResult('alpha-skill'));
    await alphaSelection;

    expect(controller.getState()).toMatchObject({
      document: { skillName: 'beta-skill' },
      draft: '# beta-skill\n',
      skillName: 'beta-skill',
    });
  });

  test('ignores a late draft event after selection reset', async () => {
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (): Promise<SkillMarkdownSaveResult> => Promise.resolve({ data: {}, ok: true }),
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Alpha draft\n');
    controller.revertDraft();
    const betaSelection = controller.select('beta-skill');
    controller.setDraft('# Late alpha input\n');
    await betaSelection;

    expect(controller.getState().draft).toBe('# beta-skill\n');
  });

  test('keeps an in-flight save bound to its original skill and ignores its stale response', async () => {
    const pendingSave = deferred<SkillMarkdownSaveResult>();
    const saves: { content: string; skillName: string }[] = [];
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (input) => {
        saves.push({ content: input.content, skillName: input.skillName });
        return pendingSave.promise;
      },
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Saved alpha edit\n');
    const alphaSave = controller.save();
    controller.revertDraft();
    await controller.select('beta-skill');
    pendingSave.resolve({ data: { document: documentResult('alpha-skill', '# Saved alpha edit\n').data }, ok: true });
    await alphaSave;

    expect(saves).toEqual([{ content: '# Saved alpha edit\n', skillName: 'alpha-skill' }]);
    expect(controller.getState()).toMatchObject({
      document: { skillName: 'beta-skill' },
      draft: '# beta-skill\n',
      message: null,
      skillName: 'beta-skill',
    });
  });

  test('ignores draft input while a save is in flight', async () => {
    const pendingSave = deferred<SkillMarkdownSaveResult>();
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: () => pendingSave.promise,
    });

    await controller.select('alpha-skill');
    controller.setDraft('# Submitted draft\n');
    const save = controller.save();

    controller.setDraft('# Input during save\n');

    expect(controller.getState()).toMatchObject({
      dirty: true,
      draft: '# Submitted draft\n',
      saving: true,
    });

    pendingSave.resolve({
      data: { document: documentResult('alpha-skill', '# Submitted draft\n').data },
      ok: true,
    });
    await save;

    expect(controller.getState()).toMatchObject({
      dirty: false,
      draft: '# Submitted draft\n',
      saving: false,
    });
  });
});
