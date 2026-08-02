import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor } from '../schema';

const owner = 'V4' as const;
const wrapper = 'apps/web/src/server/sync.ts';
const operation = (name: string, descriptor: OperationDescriptor) =>
  currentRecord(owner, {
    currentOwner: wrapper,
    evidence: [
      { kind: 'source', reference: `${wrapper} exports ${name}` },
      {
        kind: 'test',
        reference:
          'apps/web/src/server/sync-data.server.test.ts; apps/web/src/server/manual-merge-upload.server.test.ts',
      },
    ],
    id: `op:${name}`,
    kind: 'operation',
    operation: descriptor,
  });

export default defineParityShard({
  owner,
  records: [
    operation('getSyncFleet', {
      currentMethod: 'GET',
      implementationOwner: 'apps/web/src/server/sync-data.server.ts#getSyncFleetForServer',
      inputParser: 'none',
      outputParser: 'TanStack serializer over Sync fleet result; add a runtime output schema in V4',
      publicErrors: ['ForbiddenDemo', 'IncompatibleStore', 'Unavailable'],
      target: 'sync.fleet',
      transport: 'query',
    }),
    operation('exportManualMergeBundle', {
      currentMethod: 'POST',
      implementationOwner: 'apps/web/src/server/sync-data.server.ts#exportManualMergeBundleForServer',
      inputParser: 'identity input (replace with bounded explicit route input)',
      outputParser: 'current server-function file result; file bytes are excluded from oRPC',
      publicErrors: ['ForbiddenDemo', 'Forbidden', 'InvalidInput', 'Unavailable'],
      target: 'explicit download route with optional bounded oRPC metadata',
      transport: 'file',
    }),
  ],
});
