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

  test('discards the previous draft when selection changes and cannot save it under the next skill', async () => {
    const saves: { content: string; skillName: string }[] = [];
    const controller = createSkillMarkdownEditorController({
      loadMarkdown: (skillName) => Promise.resolve(documentResult(skillName)),
      saveMarkdown: (input) => {
        saves.push({ content: input.content, skillName: input.skillName });
        return Promise.resolve({ data: { document: documentResult(input.skillName, input.content).data }, ok: true });
      },
    });

    await controller.select('alpha-skill');
    controller.startEditing();
    controller.setDraft('# Unsaved alpha draft\n');

    await controller.select('beta-skill');
    await controller.save();

    expect(controller.getState()).toMatchObject({
      document: { skillName: 'beta-skill' },
      draft: '# beta-skill\n',
      editing: false,
      skillName: 'beta-skill',
    });
    expect(saves).toEqual([]);
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
    controller.startEditing();
    controller.setDraft('# Alpha draft\n');
    await controller.select('beta-skill');
    controller.setDraft('# Late alpha input\n');
    controller.startEditing();

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
    controller.startEditing();
    controller.setDraft('# Saved alpha edit\n');
    const alphaSave = controller.save();
    await controller.select('beta-skill');
    pendingSave.resolve({ data: { document: documentResult('alpha-skill', '# Saved alpha edit\n').data }, ok: true });
    await alphaSave;

    expect(saves).toEqual([{ content: '# Saved alpha edit\n', skillName: 'alpha-skill' }]);
    expect(controller.getState()).toMatchObject({
      document: { skillName: 'beta-skill' },
      draft: '# beta-skill\n',
      editing: false,
      message: null,
      skillName: 'beta-skill',
    });
  });
});
