import { currentRecord } from '../helpers';
import { defineParityShard, type OperationDescriptor } from '../schema';

const owner = 'V3' as const;
const wrapper = 'apps/web/src/server/skills.ts';
const operation = (
  name: string,
  inputParser: string,
  descriptor: Omit<OperationDescriptor, 'inputParser' | 'outputParser'>,
) =>
  currentRecord(owner, {
    currentOwner: wrapper,
    evidence: [
      { kind: 'source', reference: `${wrapper} exports ${name}` },
      { kind: 'test', reference: 'apps/web/src/server/skills.server.test.ts; apps/web/e2e/skills.spec.ts' },
    ],
    id: `op:${name}`,
    kind: 'operation',
    operation: {
      ...descriptor,
      inputParser,
      outputParser: 'TanStack serializer over Skills application results; add a runtime output schema in V3',
    },
  });

const skillsErrors = ['ForbiddenDemo', 'InvalidInput', 'SkillsConflict', 'Unavailable'] as const;

export default defineParityShard({
  owner,
  records: [
    operation('getSkillManagementSnapshot', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readSnapshot',
      publicErrors: skillsErrors,
      target: 'skills.snapshot',
      transport: 'query',
    }),
    operation('refreshSkillManagementSnapshot', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#refreshSnapshot',
      publicErrors: skillsErrors,
      target: 'skills.refreshSnapshot',
      transport: 'mutation',
    }),
    operation('getKnownSkillProjectPaths', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readKnownProjectPaths',
      publicErrors: skillsErrors,
      target: 'skills.knownProjectPaths',
      transport: 'query',
    }),
    operation('saveSkillManagementConfig', 'parseSkillConfigInput', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#saveConfig',
      publicErrors: skillsErrors,
      target: 'skills.saveConfig',
      transport: 'mutation',
    }),
    operation('toggleManagedSkill', 'parseSkillToggleInputForClient', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#toggleSkill',
      publicErrors: skillsErrors,
      target: 'skills.toggleProjection',
      transport: 'mutation',
    }),
    operation('reconcileManagedSkill', 'skillNameInputForClient', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#reconcileSkill',
      publicErrors: skillsErrors,
      target: 'skills.reconcileOne',
      transport: 'mutation',
    }),
    operation('reconcileAllManagedSkills', 'none', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#reconcileAll',
      publicErrors: skillsErrors,
      target: 'skills.reconcileAll',
      transport: 'mutation',
    }),
    operation('previewReconcileAllManagedSkills', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#previewReconcileAll',
      publicErrors: skillsErrors,
      target: 'skills.previewReconcileAll (query only while side-effect-free)',
      transport: 'query',
    }),
    operation('createManagedSkillTargetDirectory', 'parseSkillTargetDirectoryInputForClient', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#createTargetDirectory',
      publicErrors: skillsErrors,
      target: 'skills.createTargetDirectory',
      transport: 'mutation',
    }),
    operation('getSkillProjectInventories', 'none', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readProjectInventories',
      publicErrors: skillsErrors,
      target: 'skills.projectInventories',
      transport: 'query',
    }),
    operation('getProjectSkillMarkdown', 'parseProjectSkillMarkdownInput', {
      currentMethod: 'GET',
      implementationOwner: 'SkillsServerAdapter#readProjectMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.projectMarkdown',
      transport: 'query',
    }),
    operation('getManagedSkillMarkdown', 'skillNameInputForClient', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#readMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.managedMarkdown',
      transport: 'query',
    }),
    operation('saveManagedSkillMarkdown', 'parseSkillMarkdownWriteInputForClient', {
      currentMethod: 'POST',
      implementationOwner: 'SkillsServerAdapter#saveMarkdown',
      publicErrors: skillsErrors,
      target: 'skills.saveManagedMarkdown',
      transport: 'mutation',
    }),
  ],
});
