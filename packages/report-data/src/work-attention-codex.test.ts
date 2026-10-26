import { expect, test } from 'bun:test';
import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import type { CodexWorkRequest, StoredCodexWorkObservation } from '@ai-usage/report-core/codex-work-observation';
import { WORK_ATTENTION_BOUNDS } from '@ai-usage/report-core/work-attention';
import type { ServedHarnessSessionFamily } from '@ai-usage/usage-store/reader';
import { harnessSessionRoot } from './work-attention-read-harness';

const at = (second: number) => canonicalInstantFromDate(new Date(Date.UTC(2026, 9, 22, 10, 0, second)));
const request = (callId: string, answeredAt: ReturnType<typeof at> | null = null): CodexWorkRequest => ({
  callId,
  askedAt: at(1),
  acknowledgedAt: answeredAt,
  rejectedAt: null,
  tool: 'request_user_input',
  questions: [{ id: 'choice', text: 'Quel seuil retenir ?', textTruncated: false, answeredAt }],
});
const observation = (
  requests: readonly CodexWorkRequest[],
  extra: Partial<StoredCodexWorkObservation> = {},
): StoredCodexWorkObservation => ({
  format: 'codex-work-v1',
  sourceSessionId: 'session',
  machineId: 'machine',
  observedAt: at(10),
  lastEventAt: at(9),
  latestUserMessageAt: at(9),
  originator: 'Codex Desktop',
  source: 'vscode',
  threadSource: 'user',
  forkedFromId: null,
  omittedRequests: 0,
  rejectedRecords: 0,
  requests,
  ...extra,
});
const family: ServedHarnessSessionFamily = {
  campaignKey: 'campaign',
  lastActiveAt: Date.parse(at(9)),
  memberCount: 1,
  members: [
    {
      activeAt: Date.parse(at(9)),
      branch: 'topic',
      campaignRoot: true,
      checkoutPath: '/work/fixture',
      machineId: 'machine',
      origin: 'human',
      parentSourceSessionId: null,
      projectLabel: 'fixture',
      rowId: 'row',
      sourceSessionId: 'session',
      startedAt: at(0),
      title: 'Fixture',
    },
  ],
};
const root = (observations: readonly StoredCodexWorkObservation[], selectedFamily = family) =>
  harnessSessionRoot({
    checkoutFacts: [],
    family: selectedFamily,
    generatedAt: at(10),
    harness: 'codex',
    now: new Date(at(10)),
    workObservations: observations,
  });

test('native answers settle only their exact request; later messages reconsider the remaining request', () => {
  const result = root([observation([request('q1', at(3)), request('q2')])]);
  expect(result.attention).toBe('human-request');
  expect(result.declared).toBeNull();
  expect(result.reconsidered).toBe(true);
  expect(result.interpretations.map((entry) => entry.kind)).toEqual([
    'request-open',
    'request-message-observed',
    'request-answered',
    'coverage-gap',
  ]);
  const answered = result.interpretations.find((entry) => entry.kind === 'request-answered');
  const fact = result.facts.find((entry) => entry.id === answered?.evidence[0]);
  expect(fact?.kind === 'codex-user-request' ? fact.request.callId : null).toBe('q1');
});

test('partial answers preserve the outstanding question and known rejection does not create a wait', () => {
  const partial = request('partial', at(3));
  const result = root([
    observation([
      {
        ...partial,
        questions: [...partial.questions, { id: 'publish', text: 'Publier ?', textTruncated: false, answeredAt: null }],
      },
    ]),
  ]);
  expect(result.attention).toBe('human-request');
  expect(result.interpretations[0]?.text).toContain('Publier ?');
  expect(result.interpretations[0]?.uncertainty).toContain('1 question(s) have a linked answer');
  expect(root([observation([{ ...request('rejected'), rejectedAt: at(2) }])]).attention).toBe('not-observable');
  expect(root([observation([request('answered', at(3))])]).attention).toBe('not-observable');
});

test('native facts stay on the exact selected machine and member, with visible omission bounds', () => {
  expect(root([observation([request('wrong-machine')], { machineId: 'another' })]).facts).toEqual([]);
  expect(root([observation([request('wrong-member')], { sourceSessionId: 'another' })]).facts).toEqual([]);
  const result = root([observation([request('q')], { omittedRequests: 3, rejectedRecords: 1 })], {
    ...family,
    memberCount: 8,
  });
  expect(result.interpretations.some((entry) => entry.text.includes('3 omitted, 1 malformed'))).toBe(true);
  expect(result.interpretations.some((entry) => entry.text.includes('1 of 8 campaign sessions'))).toBe(true);
});

test('native request evidence and interpretation remain within the browser bounds', () => {
  const result = root(
    [
      observation(
        [
          {
            ...request('x'.repeat(256)),
            questions: [{ id: 'choice', text: 'a'.repeat(512), textTruncated: true, answeredAt: null }],
          },
        ],
        { sourceSessionId: 's'.repeat(256) },
      ),
    ],
    { ...family, members: family.members.map((member) => ({ ...member, sourceSessionId: 's'.repeat(256) })) },
  );
  expect(result.facts.every((fact) => fact.id.length <= WORK_ATTENTION_BOUNDS.maxId)).toBe(true);
  expect(result.interpretations.every((entry) => entry.text.length <= WORK_ATTENTION_BOUNDS.maxDetailText)).toBe(true);
  expect(result.interpretations[0]?.text.endsWith('…')).toBe(true);
});
