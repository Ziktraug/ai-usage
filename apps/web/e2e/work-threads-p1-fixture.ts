import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const P1_SESSION_ID = 'claude-work-thread-p1';
// This native transcript has no external title registry; the collector displays its qualified fallback.
export const P1_SESSION_LABEL = 'claude claude-w';
export const P1_SESSION_TITLE = 'Investigate the task identity fixture';
export const P1_TASK_TITLE = 'Personal task identity stays stable';
export const P1_PR_KEY = 'github.com/fixture/project#78';
export const P1_QUESTION = 'Which analysis direction should we retain?';

const lines = (events: readonly unknown[]): string => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

/** Callers first validate HOME through the collected fixture's canonical resume checkout. */
export const p1FixtureFiles = async (home: string) => {
  const claude = path.join(home, '.claude/projects/-work-fixture', `${P1_SESSION_ID}.jsonl`);
  const codex = path.join(home, '.codex/sessions/2026/07/rollout-2026-07-02T09-00-00-codex-root-025.jsonl');
  const gh = path.join(home, 'fixture-bin/gh');
  for (const file of [codex, gh, path.dirname(claude)]) {
    if ((await realpath(file)) !== file) {
      throw new Error('P1 native fixtures must stay in the canonical disposable HOME.');
    }
  }
  const common = { cwd: path.join(home, 'work/fixture'), sessionId: P1_SESSION_ID };
  const assistant = (timestamp: string) => ({
    ...common,
    type: 'assistant',
    timestamp,
    uuid: `assistant-${timestamp}`,
    requestId: `request-${timestamp}`,
    message: {
      id: `message-${timestamp}`,
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'The analysis is available.' }],
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  return {
    codex,
    async seedSession() {
      await writeFile(
        claude,
        lines([
          {
            ...common,
            type: 'user',
            timestamp: '2026-07-03T11:30:00.000Z',
            uuid: 'p1-user',
            message: { role: 'user', content: P1_SESSION_TITLE },
          },
          assistant('2026-07-03T11:31:00.000Z'),
        ]),
        { mode: 0o600 },
      );
    },
    async discoverPullRequest() {
      await appendFile(
        claude,
        lines([
          {
            ...common,
            type: 'pr-link',
            timestamp: '2026-07-03T11:32:00.000Z',
            prUrl: 'https://github.com/fixture/project/pull/78',
            prNumber: 78,
            prRepository: 'fixture/project',
          },
          assistant('2026-07-03T11:33:00.000Z'),
        ]),
      );
      const source = await readFile(gh, 'utf8');
      const needle = 'rest.includes("--author=@me") ? [';
      if (!source.includes(needle)) {
        throw new Error('The isolated gh discovery fixture changed shape.');
      }
      const discovered = JSON.stringify({
        number: 78,
        repository: { nameWithOwner: 'fixture/project' },
        title: 'Later discovered task pull request',
        url: 'https://github.com/fixture/project/pull/78',
        updatedAt: '2026-07-03T11:32:00Z',
        isDraft: false,
      });
      await writeFile(gh, source.replace(needle, `${needle}${discovered},`));
    },
    async ask() {
      await appendFile(
        codex,
        lines([
          {
            type: 'response_item',
            timestamp: '2026-07-03T11:35:00.000Z',
            payload: {
              type: 'function_call',
              name: 'request_user_input',
              call_id: 'p1-request-call',
              arguments: JSON.stringify({
                questions: [
                  {
                    id: 'p1-direction',
                    header: 'Direction',
                    question: P1_QUESTION,
                    options: [
                      { label: 'A', description: 'Direction A' },
                      { label: 'B', description: 'Direction B' },
                    ],
                  },
                ],
              }),
            },
          },
        ]),
      );
    },
    async answer() {
      await appendFile(
        codex,
        lines([
          {
            type: 'response_item',
            timestamp: '2026-07-03T11:36:00.000Z',
            payload: {
              type: 'function_call_output',
              call_id: 'p1-request-call',
              output: JSON.stringify({ answers: { 'p1-direction': { answers: ['A'] } } }),
            },
          },
        ]),
      );
    },
  };
};
