export const E2E_SKILLS_FIXTURE_HEADER = 'x-ai-usage-e2e-skills-fixture';

export type E2ESkillsFixtureVariant = 'extended' | 'visual';

export const e2eSkillsFixtureVariantForHeaders = (headers: Headers): E2ESkillsFixtureVariant =>
  headers.get(E2E_SKILLS_FIXTURE_HEADER) === 'visual' ? 'visual' : 'extended';
