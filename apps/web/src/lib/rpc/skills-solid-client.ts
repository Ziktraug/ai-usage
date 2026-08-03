import type {
  ProjectSkillMarkdownInput,
  SaveSkillMarkdownInput,
  SkillManagementConfig,
  SkillTargetInput,
  SkillToggleInput,
} from '@ai-usage/web-contract/skills';
import type { SkillMarkdownSaveResult as LegacySkillMarkdownSaveData } from '../../server/skills-contracts';
import { parseSkillSnapshotResult } from '../../skills-client-contracts';
import { createSkillsClient } from './skills-client';
import { resolveSolidWebRpcClient } from './solid-client';

type LegacySkillMarkdownSaveResult =
  | { readonly data: LegacySkillMarkdownSaveData; readonly ok: true }
  | { readonly error: { readonly message: string; readonly tag: string }; readonly ok: false };

const skillsClient = async () => createSkillsClient((await resolveSolidWebRpcClient()).skills);

export const getSkillManagementSnapshot = async () => await (await skillsClient()).getSkillManagementSnapshot();

export const refreshSkillManagementSnapshot = async () => await (await skillsClient()).refreshSkillManagementSnapshot();

export const getKnownSkillProjectPaths = async () => await (await skillsClient()).getKnownSkillProjectPaths();

export const saveSkillManagementConfig = async ({ data }: { data: SkillManagementConfig }) =>
  await (await skillsClient()).saveSkillManagementConfig(data);

export const toggleManagedSkill = async ({ data }: { data: SkillToggleInput }) =>
  await (await skillsClient()).toggleManagedSkill(data);

export const reconcileManagedSkill = async ({ data }: { data: string }) =>
  await (await skillsClient()).reconcileManagedSkill(data);

export const reconcileAllManagedSkills = async () => await (await skillsClient()).reconcileAllManagedSkills();

export const previewReconcileAllManagedSkills = async () =>
  await (await skillsClient()).previewReconcileAllManagedSkills();

export const createManagedSkillTargetDirectory = async ({ data }: { data: SkillTargetInput }) =>
  await (await skillsClient()).createManagedSkillTargetDirectory(data);

export const getSkillProjectInventories = async () => await (await skillsClient()).getSkillProjectInventories();

export const getProjectSkillMarkdown = async ({ data }: { data: ProjectSkillMarkdownInput }) =>
  await (await skillsClient()).getProjectSkillMarkdown(data);

export const getManagedSkillMarkdown = async ({ data }: { data: string }) =>
  await (await skillsClient()).getManagedSkillMarkdown(data);

export const saveManagedSkillMarkdown = async ({
  data,
}: {
  data: SaveSkillMarkdownInput;
}): Promise<LegacySkillMarkdownSaveResult> => {
  const result = await (await skillsClient()).saveManagedSkillMarkdown(data);
  if (!result.ok) {
    return result;
  }
  if ('reason' in result.data) {
    return { data: { reason: result.data.reason }, ok: true };
  }
  const snapshot = parseSkillSnapshotResult({ data: result.data.snapshot, ok: true });
  if (!snapshot.ok) {
    throw new Error('Invalid successful skills snapshot response');
  }
  return {
    data: { document: result.data.document, snapshot: snapshot.data },
    ok: true,
  };
};

export type { KnownSkillProjectPath } from '@ai-usage/web-contract/skills';
