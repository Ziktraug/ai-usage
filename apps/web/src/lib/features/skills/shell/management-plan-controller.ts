import type { ReconcilePlanSummary } from '../../../../skills-page-model';
import type { StateSubscription } from '../../../foundation/subscription';

export interface SkillsManagementPlanController extends StateSubscription<ReconcilePlanSummary | null> {
  readonly clear: () => void;
  readonly publish: (plan: ReconcilePlanSummary | null) => void;
}

export const createSkillsManagementPlanController = (): SkillsManagementPlanController => {
  let plan: ReconcilePlanSummary | null = null;
  const listeners = new Set<(next: ReconcilePlanSummary | null) => void>();
  const publish = (next: ReconcilePlanSummary | null): void => {
    plan = next;
    for (const listener of listeners) {
      listener(plan);
    }
  };
  return {
    clear: () => publish(null),
    getState: () => plan,
    publish,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
