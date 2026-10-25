import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GIT_EMPTY_TREE } from '@ai-usage/report-core/work-attempts';
import {
  freezeDelegationScope,
  parseGitHubRemotes,
  readDelegationCheckoutFacts,
  resolveDelegationCheckout,
} from './delegation-checkout';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_NAME: 'Fixture',
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

const temporary = async (prefix: string): Promise<string> => {
  const created = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(created);
  return created;
};

/** A repository with three commits on `main` (a.txt once, twice, then b.txt) and a side branch. */
const repository = async () => {
  const root = await temporary('delegation-checkout-');
  const git = gitIn(root);
  await git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '-q', '-m', 'first');
  const first = (await git('rev-parse', 'HEAD')).trim();
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  await git('commit', '-q', '-am', 'second');
  const second = (await git('rev-parse', 'HEAD')).trim();
  await mkdir(path.join(root, 'pkg'));
  await writeFile(path.join(root, 'pkg', 'b.txt'), 'b\n');
  await git('add', 'pkg/b.txt');
  await git('commit', '-q', '-m', 'third');
  const third = (await git('rev-parse', 'HEAD')).trim();
  await git('checkout', '-q', '-b', 'side', first);
  await writeFile(path.join(root, 'side.txt'), 'side\n');
  await git('add', 'side.txt');
  await git('commit', '-q', '-m', 'side');
  const side = (await git('rev-parse', 'HEAD')).trim();
  await git('checkout', '-q', 'main');
  return { first, git, root, second, side, third };
};

/** An environment whose HOME has no git configuration, so only the checkout's own config answers. */
const isolatedEnv = async () => ({ HOME: await temporary('delegation-checkout-home-'), PATH: process.env.PATH });

describe('resolveDelegationCheckout', () => {
  test('canonicalizes a subdirectory or a symlink to the repository top level and names the admitting target', async () => {
    const { root } = await repository();
    const link = path.join(await temporary('delegation-checkout-link-'), 'linked');
    await symlink(root, link);
    const targets = [
      { checkoutPath: '/somewhere/else', label: null },
      { checkoutPath: path.dirname(root), label: 'parent' },
      { checkoutPath: root, label: 'exact' },
    ];
    expect(await resolveDelegationCheckout(path.join(root, 'pkg'), targets)).toEqual({
      admittedBy: path.dirname(root),
      path: root,
      projectLabel: path.basename(root),
    });
    expect(await resolveDelegationCheckout(path.join(link, 'pkg', '..', 'pkg'), [targets[2] as never])).toEqual({
      admittedBy: root,
      path: root,
      projectLabel: path.basename(root),
    });
    expect(await resolveDelegationCheckout(root, [targets[0] as never])).toMatchObject({
      admittedBy: null,
      path: root,
    });
    expect(await resolveDelegationCheckout(root, [])).toMatchObject({ admittedBy: null });
  });

  test('refuses a relative, missing, non-directory or non-repository path as checkout-unavailable', async () => {
    const outside = await temporary('delegation-checkout-outside-');
    await writeFile(path.join(outside, 'file.txt'), 'x\n');
    for (const candidate of ['relative/path', path.join(outside, 'missing'), path.join(outside, 'file.txt'), outside]) {
      const result = await resolveDelegationCheckout(candidate, [{ checkoutPath: '/', label: null }]);
      expect(result).toMatchObject({ failure: 'checkout-unavailable' });
      expect((result as { message: string }).message.length).toBeGreaterThan(0);
    }
  });
});

describe('readDelegationCheckoutFacts', () => {
  test('reads github.com remotes in every URL form, the declared account for one owner, and the author email', async () => {
    const { git, root } = await repository();
    await git('remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git');
    await git('remote', 'add', 'mirror', 'https://github.com/acme/widgets');
    await git('remote', 'add', 'ssh', 'ssh://git@github.com/ACME/Other.git');
    await git('remote', 'add', 'lab', 'https://gitlab.example.com/acme/widgets.git');
    await git('config', 'user.email', 'author@example.invalid');
    const facts = await readDelegationCheckoutFacts(
      root,
      [
        { ghUser: 'other-login', host: 'github.com', owner: 'someone' },
        { ghUser: 'acme-bot', host: 'github.com', owner: 'acme' },
      ],
      { env: await isolatedEnv() },
    );
    // `git remote -v` lists remotes by name (lab, mirror, origin, ssh): the first spelling is `mirror`'s.
    expect(facts).toEqual({
      gitAuthorEmail: {
        provenance: 'observed',
        source: 'git config --get user.email',
        value: 'author@example.invalid',
      },
      githubAccount: { provenance: 'declared', source: 'github.accounts[owner=acme]', value: 'acme-bot' },
      githubOwners: { provenance: 'observed', source: 'git remote -v', value: ['acme'] },
      repositories: { provenance: 'observed', source: 'git remote -v', value: ['ACME/Other', 'acme/widgets'] },
    });
  });

  test('leaves the account unknown with no remote, several owners or no declared entry; the email unknown when unset', async () => {
    const { git, root } = await repository();
    const env = await isolatedEnv();
    const bare = await readDelegationCheckoutFacts(root, [{ ghUser: 'x', host: 'github.com', owner: 'acme' }], { env });
    expect(bare).toEqual({
      gitAuthorEmail: { provenance: 'unknown', source: 'git config --get user.email (unset)', value: null },
      githubAccount: { provenance: 'unknown', source: 'github.accounts (no github.com remote)', value: null },
      githubOwners: { provenance: 'observed', source: 'git remote -v', value: [] },
      repositories: { provenance: 'observed', source: 'git remote -v', value: [] },
    });
    await git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    const undeclared = await readDelegationCheckoutFacts(root, [], { env });
    expect(undeclared.githubAccount).toEqual({
      provenance: 'unknown',
      source: 'github.accounts (no entry for owner acme)',
      value: null,
    });
    await git('remote', 'add', 'fork', 'git@github.com:someone/widgets.git');
    const several = await readDelegationCheckoutFacts(root, [{ ghUser: 'x', host: 'github.com', owner: 'acme' }], {
      env,
    });
    expect(several.githubOwners.value).toEqual(['acme', 'someone']);
    expect(several.githubAccount).toMatchObject({
      provenance: 'unknown',
      source: 'github.accounts (several owners observed)',
    });
  });

  test('outside a repository every git-backed fact is unknown, never guessed', async () => {
    const outside = await temporary('delegation-checkout-outside-');
    const facts = await readDelegationCheckoutFacts(outside, [], { env: await isolatedEnv() });
    expect(facts.githubOwners).toMatchObject({ provenance: 'unknown', value: null });
    expect(facts.repositories).toMatchObject({ provenance: 'unknown', value: null });
    expect(facts.githubAccount).toMatchObject({ provenance: 'unknown', value: null });
    expect(facts.gitAuthorEmail).toMatchObject({ provenance: 'unknown', value: null });
  });

  test('parses remote listings strictly: github.com only, valid owner and repository names only', () => {
    const listing = [
      'origin\tgit@github.com:Acme/Widgets.git (fetch)',
      'origin\tgit@github.com:Acme/Widgets.git (push)',
      'https\thttps://user@github.com/Acme/Widgets (fetch)',
      'ssh\tssh://git@github.com/acme/deep.git/ (fetch)',
      'evil\thttps://github.com.example.com/acme/widgets (fetch)',
      'bad\thttps://github.com/-bad/name (fetch)',
      'nested\thttps://github.com/acme/widgets/extra (fetch)',
      'not a remote line',
    ].join('\n');
    expect(parseGitHubRemotes(listing)).toEqual([
      { owner: 'Acme', repository: 'Widgets' },
      { owner: 'Acme', repository: 'Widgets' },
      { owner: 'Acme', repository: 'Widgets' },
      { owner: 'acme', repository: 'deep' },
    ]);
  });
});

describe('freezeDelegationScope', () => {
  test('freezes a commit by ref, short SHA or relative revision to its SHA and first parent', async () => {
    const { first, root, second, third } = await repository();
    expect(await freezeDelegationScope(root, { commit: 'main', kind: 'commit' })).toEqual({
      base: 'first-parent',
      baseRef: null,
      baseSha: second,
      commitCount: 1,
      headRef: 'main',
      headSha: third,
      kind: 'commit',
    });
    expect(await freezeDelegationScope(root, { commit: second.slice(0, 8), kind: 'commit' })).toMatchObject({
      baseSha: first,
      headSha: second,
    });
    expect(await freezeDelegationScope(root, { commit: 'HEAD~2', kind: 'commit' })).toEqual({
      base: 'empty-tree',
      baseRef: null,
      baseSha: GIT_EMPTY_TREE.sha1,
      commitCount: 1,
      headRef: 'HEAD~2',
      headSha: first,
      kind: 'commit',
    });
  });

  test('freezes a range when the base is an ancestor of the head, counting its commits', async () => {
    const { first, root, side, third } = await repository();
    expect(await freezeDelegationScope(root, { base: 'HEAD~2', head: 'main', kind: 'range' })).toEqual({
      base: 'range-base',
      baseRef: 'HEAD~2',
      baseSha: first,
      commitCount: 2,
      headRef: 'main',
      headSha: third,
      kind: 'range',
    });
    const diverged = await freezeDelegationScope(root, { base: 'side', head: 'main', kind: 'range' });
    expect(diverged).toMatchObject({ failure: 'scope-unavailable' });
    expect((diverged as { message: string }).message).toContain(`side (${side}) is not an ancestor`);
    const empty = await freezeDelegationScope(root, { base: 'main', head: third, kind: 'range' });
    expect(empty).toMatchObject({ failure: 'scope-unavailable' });
    expect((empty as { message: string }).message).toContain('the range is empty');
  });

  test('refuses an unknown revision, a non-commit and anything git could read as an option, before git sees it', async () => {
    const { root } = await repository();
    expect(await freezeDelegationScope(root, { commit: 'no-such-ref', kind: 'commit' })).toMatchObject({
      failure: 'scope-unavailable',
      message: 'no-such-ref does not resolve to a commit in this checkout',
    });
    expect(await freezeDelegationScope(root, { commit: 'HEAD:a.txt', kind: 'commit' })).toMatchObject({
      failure: 'scope-unavailable',
    });
    for (const revision of ['--output=/tmp/x', '-n', 'with space', '', 'a'.repeat(257)]) {
      expect(await freezeDelegationScope(root, { commit: revision, kind: 'commit' })).toMatchObject({
        failure: 'scope-unavailable',
        message: 'a revision must match the request pattern and must not start with "-"',
      });
      expect(await freezeDelegationScope(root, { base: revision, head: 'main', kind: 'range' })).toMatchObject({
        failure: 'scope-unavailable',
      });
    }
    const outside = await temporary('delegation-checkout-outside-');
    expect(await freezeDelegationScope(outside, { commit: 'HEAD', kind: 'commit' })).toMatchObject({
      failure: 'scope-unavailable',
    });
  });
});
