import { describe, expect, test } from 'bun:test';
import {
  compactSessionVcsBranchObservations,
  normalizeSessionVcsPullRequests,
  normalizeSessionVcsRepository,
  parseSessionVcsContext,
  sessionVcsBranchUrl,
  sessionVcsCommitUrl,
} from './session-vcs';

const githubRepository = {
  host: 'github.com',
  ownerPath: 'openai/codex',
  provenance: 'harness-recorded' as const,
  webUrl: 'https://github.com/openai/codex',
};

describe('session VCS context', () => {
  test('normalizes safe GitHub and GitLab HTTPS and SCP remotes without guessing unknown forges', () => {
    expect(normalizeSessionVcsRepository('https://github.com/openai/codex.git', 'harness-recorded')).toEqual(
      githubRepository,
    );
    expect(normalizeSessionVcsRepository('git@gitlab.com:group/project.git', 'local-derived')).toEqual({
      host: 'gitlab.com',
      ownerPath: 'group/project',
      provenance: 'local-derived',
      webUrl: 'https://gitlab.com/group/project',
    });
    expect(normalizeSessionVcsRepository('git@work-alias:group/project.git', 'harness-recorded')).toEqual({
      host: 'work-alias',
      ownerPath: 'group/project',
      provenance: 'harness-recorded',
      webUrl: null,
    });
  });

  test('rejects credentials, query, fragment, dangerous schemes, and malformed owner paths', () => {
    const rejected = [
      'https://user:secret@github.com/openai/codex',
      'https://github.com/openai/codex?token=secret',
      'https://github.com/openai/codex#secret',
      'http://github.com/openai/codex',
      'javascript:alert(1)',
      'file:///private/repo',
      'git@github.com:single-segment',
    ];
    for (const remote of rejected) {
      expect(normalizeSessionVcsRepository(remote, 'harness-recorded')).toBeNull();
    }
  });

  test('constructs segment-aware branch and commit URLs for supported forges', () => {
    expect(sessionVcsBranchUrl(githubRepository, 'feature/a b')).toBe(
      'https://github.com/openai/codex/tree/feature/a%20b',
    );
    expect(sessionVcsCommitUrl(githubRepository, '0123456789abcdef')).toBe(
      'https://github.com/openai/codex/commit/0123456789abcdef',
    );
    const gitlab = normalizeSessionVcsRepository('git@gitlab.com:group/project.git', 'local-derived');
    expect(gitlab && sessionVcsBranchUrl(gitlab, 'topic/one')).toBe(
      'https://gitlab.com/group/project/-/tree/topic/one',
    );
    expect(gitlab && sessionVcsCommitUrl(gitlab, 'abcdef')).toBe('https://gitlab.com/group/project/-/commit/abcdef');
  });

  test('compacts consecutive branches and deduplicates PRs chronologically', () => {
    expect(
      compactSessionVcsBranchObservations(
        [
          { name: 'main', observedAt: '2026-01-01T00:00:00.000Z' },
          { name: 'main', observedAt: '2026-01-01T00:01:00.000Z' },
          { name: 'topic', observedAt: '2026-01-01T00:02:00.000Z' },
        ],
        'harness-recorded',
        githubRepository,
      ),
    ).toEqual({
      partial: false,
      spans: [
        {
          firstObservedAt: '2026-01-01T00:00:00.000Z',
          lastObservedAt: '2026-01-01T00:01:00.000Z',
          name: 'main',
          provenance: 'harness-recorded',
          webUrl: 'https://github.com/openai/codex/tree/main',
        },
        {
          firstObservedAt: '2026-01-01T00:02:00.000Z',
          lastObservedAt: '2026-01-01T00:02:00.000Z',
          name: 'topic',
          provenance: 'harness-recorded',
          webUrl: 'https://github.com/openai/codex/tree/topic',
        },
      ],
    });
    expect(
      normalizeSessionVcsPullRequests([
        {
          number: 2,
          observedAt: '2026-01-01T00:02:00.000Z',
          repository: 'openai/codex',
          url: 'https://github.com/openai/codex/pull/2',
        },
        {
          number: 1,
          observedAt: '2026-01-01T00:01:00.000Z',
          repository: 'openai/codex',
          url: 'https://github.com/openai/codex/pull/1',
        },
        {
          number: 1,
          observedAt: '2026-01-01T00:03:00.000Z',
          repository: 'openai/codex',
          url: 'https://github.com/openai/codex/pull/1',
        },
      ]),
    ).toMatchObject({ partial: false, pullRequests: [{ number: 1 }, { number: 2 }] });
  });

  test('strictly validates bounded credential-free deterministic context', () => {
    const context = {
      branches: [],
      headCommit: null,
      partial: false,
      pullRequests: [],
      repository: githubRepository,
    };
    expect(parseSessionVcsContext(context)).toEqual(context);
    expect(() => parseSessionVcsContext({ ...context, secret: true })).toThrow();
    expect(() =>
      parseSessionVcsContext({
        ...context,
        pullRequests: [{ number: 1, observedAt: null, repository: null, url: 'javascript:alert(1)' }],
      }),
    ).toThrow();
    expect(() =>
      parseSessionVcsContext({
        ...context,
        branches: Array.from({ length: 33 }, (_, index) => ({
          firstObservedAt: null,
          lastObservedAt: null,
          name: `branch-${index}`,
          provenance: 'harness-recorded',
          webUrl: null,
        })),
      }),
    ).toThrow();
  });
});
