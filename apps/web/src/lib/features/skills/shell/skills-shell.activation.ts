import type { ComponentProps } from 'svelte';
import type { WebQueryHydrationState } from '../../../query/client';
import type SkillsShellHydrationFixture from './skills-shell.hydration.fixture.svelte';

export const skillsShellHydrationProps = (
  hydrationState: WebQueryHydrationState,
): ComponentProps<typeof SkillsShellHydrationFixture> => ({
  hydrationState,
  pathname: '/skills/global/activation-fixture',
});
