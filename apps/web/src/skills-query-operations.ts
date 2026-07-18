import type { SkillManagementConfig } from '@ai-usage/skills';
import {
  type KnownProjectPathsResult,
  parseKnownProjectPathsResult,
  parseSkillReconcileResult,
  parseSkillSnapshotResult,
  type SkillReconcileServerResult,
  type SkillSnapshotResult,
} from './skills-client-contracts';

export type SkillsMutationRequest =
  | { type: 'save-config'; config: SkillManagementConfig }
  | { type: 'toggle'; enabled: boolean; skillName: string }
  | { type: 'reconcile-one'; skillName: string }
  | { type: 'preview-reconcile' }
  | { type: 'reconcile-all' }
  | { type: 'create-target'; targetId: string }
  | { type: 'refresh' };

export type SkillsMutationResult =
  | { type: 'save-config' | 'create-target'; result: SkillSnapshotResult }
  | { type: 'toggle' | 'reconcile-one' | 'preview-reconcile' | 'reconcile-all'; result: SkillReconcileServerResult }
  | { type: 'refresh'; knownProjectPaths: KnownProjectPathsResult; result: SkillSnapshotResult };

export interface SkillsMutationPorts {
  createTarget(input: { data: { targetId: string } }): Promise<unknown>;
  knownProjectPaths(): Promise<unknown>;
  previewReconcile(): Promise<unknown>;
  reconcileAll(): Promise<unknown>;
  reconcileOne(input: { data: string }): Promise<unknown>;
  refresh(): Promise<unknown>;
  saveConfig(input: { data: SkillManagementConfig }): Promise<unknown>;
  toggle(input: { data: { enabled: boolean; skillName: string } }): Promise<unknown>;
}

export const createSkillsMutationRunner =
  (ports: SkillsMutationPorts) =>
  async (request: SkillsMutationRequest): Promise<SkillsMutationResult> => {
    switch (request.type) {
      case 'save-config':
        return {
          result: parseSkillSnapshotResult(await ports.saveConfig({ data: request.config })),
          type: request.type,
        };
      case 'toggle':
        return {
          result: parseSkillReconcileResult(
            await ports.toggle({ data: { enabled: request.enabled, skillName: request.skillName } }),
          ),
          type: request.type,
        };
      case 'reconcile-one':
        return {
          result: parseSkillReconcileResult(await ports.reconcileOne({ data: request.skillName })),
          type: request.type,
        };
      case 'preview-reconcile':
        return {
          result: parseSkillReconcileResult(await ports.previewReconcile()),
          type: request.type,
        };
      case 'reconcile-all':
        return {
          result: parseSkillReconcileResult(await ports.reconcileAll()),
          type: request.type,
        };
      case 'create-target':
        return {
          result: parseSkillSnapshotResult(await ports.createTarget({ data: { targetId: request.targetId } })),
          type: request.type,
        };
      case 'refresh': {
        const [snapshot, knownProjectPaths] = await Promise.all([ports.refresh(), ports.knownProjectPaths()]);
        return {
          knownProjectPaths: parseKnownProjectPathsResult(knownProjectPaths),
          result: parseSkillSnapshotResult(snapshot),
          type: request.type,
        };
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`Unknown skills mutation: ${String(exhaustive)}`);
      }
    }
  };
