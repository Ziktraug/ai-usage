import { Effect } from 'effect';
import { type CodexSession, hasCodexHistory, readCodexSessions, readCodexThreadNames } from '../codex-history';
import { base } from '../text';
import type { Row } from '../types';
import { normalizeUsageRow } from '../usage-normalization';

const sum = (sessions: CodexSession[], pick: (session: CodexSession) => number) =>
  sessions.reduce((total, session) => total + pick(session), 0);

export const collectCodex = Effect.gen(function* () {
  if (!(yield* hasCodexHistory)) return [];

  const names = yield* readCodexThreadNames;
  const sessions = yield* readCodexSessions;
  const byId = new Map<string, CodexSession>();
  for (const session of sessions) {
    if (session.id) byId.set(session.id, session);
  }

  const children = new Map<string, CodexSession[]>();
  const childIds = new Set<string>();
  for (const session of sessions) {
    if (session.id && session.parent && byId.has(session.parent)) {
      childIds.add(session.id);
      const siblings = children.get(session.parent) ?? [];
      siblings.push(session);
      children.set(session.parent, siblings);
    }
  }

  const rows: Row[] = [];
  for (const session of sessions) {
    if (session.id && childIds.has(session.id)) continue;
    const kids = (session.id && children.get(session.id)) || [];
    const tokens = {
      in: session.tin + sum(kids, (kid) => kid.tin),
      out: session.tout + sum(kids, (kid) => kid.tout),
      cr: session.tcr + sum(kids, (kid) => kid.tcr),
      cw: 0,
    };
    const sub = session.sub || kids.some((kid) => kid.sub);
    const end = [session, ...kids].reduce<Date | null>(
      (latest, current) => (current.end && (!latest || current.end > latest) ? current.end : latest),
      null,
    );

    rows.push(
      normalizeUsageRow({
        date: session.start,
        endDate: end,
        harness: 'Codex',
        provider: sub ? 'Codex sub' : 'Codex API',
        name:
          (session.id && names.get(session.id)) ||
          session.firstUser ||
          (session.id ? `codex ${session.id.slice(0, 8)}` : 'codex'),
        model: session.model,
        project: base(session.cwd),
        tokens,
        costActual: sub ? 0 : 'approx',
        calls: 1 + kids.length,
        turns: session.turns + sum(kids, (kid) => kid.turns),
        tools: session.tools + sum(kids, (kid) => kid.tools),
        linesAdded: null,
        linesDeleted: null,
        subagent: kids.length > 0,
      }),
    );
  }

  return rows;
});
