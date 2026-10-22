import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GIT_EMPTY_TREE, parseReviewAttemptScope } from '@ai-usage/report-core/work-attempts';
import {
  boundReviewPatch,
  prepareReviewScope,
  REVIEW_DIFF_TREE_OPTIONS,
  ReviewScopeError,
} from './claude-review-scope';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-10-22T10:00:00Z',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_COMMITTER_DATE: '2026-10-22T10:00:00Z',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
};

const gitIn =
  (cwd: string) =>
  async (...args: string[]): Promise<string> => {
    const run = Bun.spawn(['git', ...args], { cwd, env: GIT_ENV, stderr: 'pipe', stdout: 'pipe' });
    const [code, out, err] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${err}`);
    }
    return out;
  };

const repository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-review-scope-'));
  roots.push(root);
  const git = gitIn(root);
  await git('init', '-q', '-b', 'main');
  return { git, root };
};

const head = async (git: (...args: string[]) => Promise<string>) => (await git('rev-parse', 'HEAD')).trim();

describe('review scope: one commit, resolved first, compared with its first parent', () => {
  test('a regular commit: SHAs, first parent, the exact patch git produces and its hash', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await git('add', 'a.ts');
    await git('commit', '-q', '-m', 'first');
    const parent = await head(git);
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    await git('commit', '-q', '-am', 'second: change a\n\nbody line');
    const sha = await head(git);

    const { patch, scope } = await prepareReviewScope(root);
    const expected = await git(...REVIEW_DIFF_TREE_OPTIONS, parent, sha);
    expect(patch).toBe(expected);
    expect(scope).toEqual({
      base: 'first-parent',
      baseSha: parent,
      fileCount: 1,
      files: [
        { additions: 1, coverage: 'complete', deletions: 1, path: 'a.ts', previousPath: null, status: 'modified' },
      ],
      headSha: sha,
      includedBytes: Buffer.byteLength(expected),
      includedLines: expected.split('\n').length - 1,
      kind: 'commit',
      parentCount: 1,
      patchBytes: Buffer.byteLength(expected),
      patchLines: expected.split('\n').length - 1,
      patchSha256: createHash('sha256').update(expected).digest('hex'),
      repositoryPrefix: '',
      subject: 'second: change a',
      truncated: false,
      workingTreeDirty: false,
    });
    expect(parseReviewAttemptScope(scope)).toEqual(scope);
  });

  test('a root commit is compared with the empty tree; a subdirectory checkout names its prefix', async () => {
    const { git, root } = await repository();
    await Bun.write(path.join(root, 'pkg', 'b.ts'), 'export const b = 1;\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'root');
    const { scope } = await prepareReviewScope(path.join(root, 'pkg'));
    expect(scope).toMatchObject({
      base: 'empty-tree',
      baseSha: GIT_EMPTY_TREE.sha1,
      files: [{ path: 'pkg/b.ts', status: 'added' }],
      parentCount: 0,
      repositoryPrefix: 'pkg/',
    });
  });

  test('a merge is compared with its first parent only, and says so', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'base.txt'), 'base\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'base');
    await git('checkout', '-q', '-b', 'side');
    await writeFile(path.join(root, 'side.txt'), 'side\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'side');
    await git('checkout', '-q', 'main');
    await writeFile(path.join(root, 'main.txt'), 'main\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'main');
    const firstParent = await head(git);
    await git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const { scope } = await prepareReviewScope(root);
    expect(scope).toMatchObject({ base: 'first-parent', baseSha: firstParent, parentCount: 2 });
    // Against the first parent, the merge brings exactly the side branch's file.
    expect(scope.files.map((file) => file.path)).toEqual(['side.txt']);
  });

  test('renames with spaces, deletions, additions and binary files each get a status and a coverage', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'old name.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join(''));
    await writeFile(path.join(root, 'gone.txt'), 'gone\n');
    await writeFile(path.join(root, 'image.bin'), new Uint8Array([0, 1, 2, 3, 0, 255]));
    await git('add', '.');
    await git('commit', '-q', '-m', 'before');
    await git('mv', 'old name.txt', 'new name.txt');
    await git('rm', '-q', 'gone.txt');
    await writeFile(path.join(root, 'image.bin'), new Uint8Array([0, 9, 9, 9, 0, 255]));
    await writeFile(path.join(root, 'tab\tname.txt'), 'quoted\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'after');
    const { scope } = await prepareReviewScope(root);
    const byPath = new Map(scope.files.map((file) => [file.path, file]));
    expect(byPath.get('new name.txt')).toMatchObject({ previousPath: 'old name.txt', status: 'renamed' });
    expect(byPath.get('gone.txt')).toMatchObject({ coverage: 'complete', deletions: 1, status: 'deleted' });
    expect(byPath.get('image.bin')).toMatchObject({ coverage: 'binary', status: 'modified' });
    // A path with a control character is counted, never listed (it could not be rendered safely).
    expect(scope.fileCount).toBe(4);
    expect(scope.files).toHaveLength(3);
  });

  test('truncates at a line boundary, keeps a prefix of the patch and marks each file', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await writeFile(path.join(root, 'b.txt'), 'b\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'one');
    await writeFile(path.join(root, 'a.txt'), Array.from({ length: 40 }, (_, i) => `a${i}\n`).join(''));
    await writeFile(path.join(root, 'b.txt'), 'b changed\n');
    await git('commit', '-q', '-am', 'two');
    const full = await prepareReviewScope(root);
    const cut = await prepareReviewScope(root, { limits: { maxPatchPromptBytes: 200, maxPatchPromptLines: 1000 } });
    expect(cut.scope).toMatchObject({ patchBytes: full.scope.patchBytes, truncated: true });
    expect(cut.scope.includedBytes).toBeLessThanOrEqual(200);
    expect(cut.patch.endsWith('\n')).toBe(true);
    expect(Buffer.from(full.patch).subarray(0, cut.scope.includedBytes).toString()).toBe(cut.patch);
    expect(cut.scope.patchSha256).toBe(full.scope.patchSha256);
    expect(cut.scope.files.map((file) => [file.path, file.coverage])).toEqual([
      ['a.txt', 'partial'],
      ['b.txt', 'omitted'],
    ]);
    const byLines = await prepareReviewScope(root, { limits: { maxPatchPromptLines: 3 } });
    expect(byLines.scope).toMatchObject({ includedLines: 3, truncated: true });
  });

  test('states a dirty working tree, ignores untracked files and never writes the index', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'one');
    await writeFile(path.join(root, 'untracked.txt'), 'u\n');
    expect((await prepareReviewScope(root)).scope.workingTreeDirty).toBe(false);
    await writeFile(path.join(root, 'a.txt'), 'a edited\n');
    const before = await stat(path.join(root, '.git', 'index'));
    expect((await prepareReviewScope(root)).scope.workingTreeDirty).toBe(true);
    const after = await stat(path.join(root, '.git', 'index'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test('refuses when HEAD moves during preparation, rather than mixing two revisions', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'one');
    const error = await prepareReviewScope(root, {
      beforeHeadRecheck: async () => {
        await writeFile(path.join(root, 'a.txt'), 'moved\n');
        await git('commit', '-q', '-am', 'moved meanwhile');
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewScopeError);
    expect(error).toMatchObject({ kind: 'moved' });
    expect((error as Error).message).toContain('start the review again');
  });

  test('refuses what cannot be reviewed: no repository, no commit, an empty or binary-only commit, a huge patch', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'claude-review-scope-outside-'));
    roots.push(outside);
    await expect(prepareReviewScope(outside)).rejects.toMatchObject({ kind: 'no-commit' });
    const { git, root } = await repository();
    await expect(prepareReviewScope(root)).rejects.toMatchObject({ kind: 'no-commit' });
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await git('add', '.');
    await git('commit', '-q', '-m', 'one');
    await git('commit', '-q', '--allow-empty', '-m', 'empty');
    await expect(prepareReviewScope(root)).rejects.toMatchObject({ kind: 'empty' });
    await writeFile(path.join(root, 'blob.bin'), new Uint8Array([0, 1, 2]));
    await git('add', '.');
    await git('commit', '-q', '-m', 'binary only');
    await expect(prepareReviewScope(root)).rejects.toMatchObject({ kind: 'binary-only' });
    await writeFile(path.join(root, 'a.txt'), 'x'.repeat(4096));
    await git('commit', '-q', '-am', 'big');
    await expect(prepareReviewScope(root, { limits: { maxPatchReadBytes: 1024 } })).rejects.toMatchObject({
      kind: 'too-large',
    });
  });

  test('in a blobless partial clone a missing blob is refused as not local, never fetched', async () => {
    const { git, root } = await repository();
    await writeFile(path.join(root, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'first');
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    await git('commit', '-q', '-am', 'second');
    const bare = `${root}-bare.git`;
    const clone = `${root}-blobless`;
    roots.push(bare, clone);
    await git('clone', '-q', '--bare', root, bare);
    await gitIn(bare)('config', 'uploadpack.allowFilter', 'true');
    // The checkout fetches HEAD's blobs only; the first commit's version of a.txt stays remote.
    await git('clone', '-q', '--filter=blob:none', `file://${bare}`, clone);
    const cloned = gitIn(clone);
    const objects = async () => (await cloned('count-objects', '-v')).split('\n').filter(Boolean).sort();
    const missing = async () =>
      (await cloned('rev-list', '--objects', '--missing=print', 'HEAD'))
        .split('\n')
        .filter((line) => line.startsWith('?'));
    const before = { missing: await missing(), objects: await objects() };
    expect(before.missing).toHaveLength(1);

    const error = await prepareReviewScope(clone).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReviewScopeError);
    expect(error).toMatchObject({ kind: 'blob-not-local' });
    expect((error as Error).message).toContain('never fetches');
    // Nothing was fetched: the same object store, the same missing blob, no new pack.
    expect(await objects()).toEqual(before.objects);
    expect(await missing()).toEqual(before.missing);
  });

  test('never runs a diff driver, a text conversion or a pager the repository configures', async () => {
    const { git, root } = await repository();
    const marker = path.join(root, '..', `${path.basename(root)}-driver-ran`);
    roots.push(marker);
    const script = path.join(root, 'driver.sh');
    await writeFile(script, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat "$1" 2>/dev/null\n`);
    await chmod(script, 0o700);
    await git('config', 'diff.external', script);
    await git('config', 'diff.evil.textconv', script);
    await git('config', 'core.pager', script);
    await writeFile(path.join(root, '.gitattributes'), '*.txt diff=evil\n');
    await writeFile(path.join(root, 'a.txt'), 'a\n');
    await git('add', 'a.txt', '.gitattributes');
    await git('commit', '-q', '-m', 'one');
    await writeFile(path.join(root, 'a.txt'), 'b\n');
    await git('commit', '-q', '-am', 'two');
    const { patch } = await prepareReviewScope(root);
    expect(patch).toContain('-a\n+b\n');
    expect(await Bun.file(marker).exists()).toBe(false);
    // Control: the porcelain diff would have run the configured driver, so the fixture is live.
    await git('diff', 'HEAD~1', 'HEAD');
    expect(await Bun.file(marker).exists()).toBe(true);
  });
});

describe('patch bounding', () => {
  test('reads quoted paths, copy lines and the tab git appends after names with spaces', () => {
    const patch = [
      'diff --git "a/q\\"x.txt" "b/q\\"x.txt"',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ "b/q\\"x.txt"',
      '@@ -0,0 +1 @@',
      '+--- not a header',
      'diff --git a/with space.txt b/with space.txt',
      'index 1111111..2222222 100644',
      '--- a/with space.txt\t',
      '+++ b/with space.txt\t',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src.txt b/copy.txt',
      'similarity index 100%',
      'copy from src.txt',
      'copy to copy.txt',
      '',
    ].join('\n');
    const bounded = boundReviewPatch(patch, { maxPatchPromptBytes: 10_000, maxPatchPromptLines: 1000 });
    expect(bounded.files.map(({ binary: _binary, ...file }) => file)).toEqual([
      { additions: 1, coverage: 'complete', deletions: 0, path: 'q"x.txt', previousPath: null, status: 'added' },
      {
        additions: 1,
        coverage: 'complete',
        deletions: 1,
        path: 'with space.txt',
        previousPath: null,
        status: 'modified',
      },
      { additions: 0, coverage: 'complete', deletions: 0, path: 'copy.txt', previousPath: 'src.txt', status: 'copied' },
    ]);
    expect(bounded).toMatchObject({ included: patch, truncated: false });
  });
});
