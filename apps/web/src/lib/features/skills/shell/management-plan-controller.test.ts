import { describe, expect, test } from 'bun:test';
import type { ReconcilePlanSummary } from '../../../../skills-page-model';
import { createSkillsManagementPlanController } from './management-plan-controller';

describe('Skills shared management plan controller', () => {
  test('publishes one preview plan to sibling slots and cleans up subscribers', () => {
    const controller = createSkillsManagementPlanController();
    const observed: Array<ReconcilePlanSummary | null> = [];
    const plan: ReconcilePlanSummary = {
      apply: ['link alpha-skill @ Codex'],
      skipped: [],
    };
    const unsubscribe = controller.subscribe((next) => observed.push(next));

    controller.publish(plan);
    expect(controller.getState()).toBe(plan);
    controller.clear();
    expect(controller.getState()).toBeNull();

    unsubscribe();
    controller.publish(plan);
    expect(observed).toEqual([plan, null]);
  });
});
