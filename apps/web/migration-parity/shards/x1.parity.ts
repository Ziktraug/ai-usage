import { currentRecord } from '../helpers';
import { defineParityShard, type ParityRecord } from '../schema';

const owner = 'X1' as const;
const cutoverCommit = '75161d96109769a3f315565dfe4cf84ab398a708';
const completeAtCutover = (record: ParityRecord): ParityRecord => ({
  ...record,
  evidence: [
    ...record.evidence,
    {
      commit: cutoverCommit,
      kind: 'command',
      phase: 'target',
      reference: 'Canonical SvelteKit X0/X1 convergence gates preserve this frozen interface.',
    },
    {
      commit: cutoverCommit,
      kind: 'review',
      phase: 'target',
      reference: 'Independent packet reviews and /root/x0_final_review ACCEPT the integrated SvelteKit composition.',
    },
  ],
  status: 'complete',
});

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
      currentOwner: 'apps/web/vite-production-build.ts; apps/web/start.mjs; tools/check-web-production-start.ts',
      evidence: [
        { kind: 'command', reference: 'bun run test:web-production' },
        { kind: 'command', reference: 'bun run test:web-dev-build-isolation' },
        { kind: 'command', reference: 'bun run test:setup-loopback' },
      ],
      id: 'OPS-02',
      kind: 'feature',
    }),
  ].map(completeAtCutover),
});
