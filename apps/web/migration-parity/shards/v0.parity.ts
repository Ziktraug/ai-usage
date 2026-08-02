import { currentRecord } from '../helpers';
import { defineParityShard } from '../schema';

const owner = 'V0' as const;

export default defineParityShard({
  owner,
  records: [
    currentRecord(owner, {
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
    }),
  ],
});
