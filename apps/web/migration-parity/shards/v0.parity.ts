import { currentRecord } from '../helpers';
import { defineParityShard, parityEvidence } from '../schema';

const owner = 'V0' as const;
const implementationCommit = '26967ea7a70fe29503eb54175e11ddb70efd664e';
const reworkCommit = '5f3af77db5f760760db6fd83e0908979ba293fde';
const integratedCommit = '771197457b1db152934f427b09849a18c8e28981';

const baselineSecurityRecord = currentRecord(owner, {
  currentOwner: 'apps/web/src/start.ts; apps/web/src/server/local-request-trust.server.ts',
  evidence: [
    {
      kind: 'test',
      reference: 'apps/web/src/start.test.ts; apps/web/src/server/local-request-trust.server.test.ts',
    },
    { kind: 'test', reference: 'apps/web/e2e/demo-privacy.spec.ts' },
  ],
  id: 'SECURITY-01',
  kind: 'feature',
});

export default defineParityShard({
  owner,
  records: [
    {
      ...baselineSecurityRecord,
      evidence: [
        ...baselineSecurityRecord.evidence,
        parityEvidence({
          commit: integratedCommit,
          kind: 'source',
          phase: 'target',
          reference:
            'apps/web/src/lib/server/rpc/request-policy.ts; packages/web-contract/src/errors.ts; packages/web-contract/src/schema-conventions.ts; packages/web-contract/package.json',
        }),
        parityEvidence({
          commit: implementationCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'apps/web/src/lib/server/rpc/request-policy.test.ts; packages/web-contract/src/architecture.test.ts; packages/web-contract/src/errors.test.ts; packages/web-contract/src/schema-conventions.test.ts',
        }),
        parityEvidence({
          commit: reworkCommit,
          kind: 'test',
          phase: 'target',
          reference:
            'packages/web-contract/src/schema-conventions.test.ts rejects array accessors without invoking getters',
        }),
        parityEvidence({
          commit: integratedCommit,
          kind: 'command',
          phase: 'target',
          reference:
            'bun test packages/web-contract apps/web/src/lib/server/rpc tools/check-package-boundaries.test.ts (53 tests, 792 assertions); bun run lint; bun run typecheck; bun run --cwd apps/web build:svelte',
        }),
        parityEvidence({
          commit: integratedCommit,
          kind: 'review',
          phase: 'target',
          reference: 'Independent V0 re-review ACCEPT on parity/spec and code-quality/seams over 26967ea..7711974',
        }),
      ],
      status: 'complete',
    },
  ],
});
