import { afterAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import { createServer } from 'vite';
import { createWebRpcHttpHandler } from '../../../server/rpc/handler.server';
import type { WebRpcRouterDependencies } from '../../../server/rpc/router';
import type { SkillsCapability, SkillsCapabilityResult } from '../../../server/rpc/skills';
import { syntheticManagementSnapshot } from '../management/synthetic-fixture.test-helper';
import { createSkillsPresentationProjection } from '../presentation';
import { loadSkillsShellRoute } from './data';
import { createSkillsShellViewModel, normalizeSkillsQuerySnapshot } from './model';
import {
  syntheticExposureTruncatedObservations,
  syntheticInventories,
  syntheticKnownPaths,
  syntheticManagedDocument,
  syntheticObservations,
  syntheticProjectDocument,
  syntheticProvisionalObservations,
  syntheticSnapshot,
} from './synthetic-fixture.test-helper';

interface SvelteServerModule {
  render: (component: Component, options?: { props?: Record<string, unknown> }) => { body: string };
}

const componentFrom = (loaded: unknown): Component => {
  if (typeof loaded !== 'object' || loaded === null || !('default' in loaded) || typeof loaded.default !== 'function') {
    throw new Error('Skills workspace fixture did not expose a Svelte component');
  }
  return loaded.default as Component;
};

const rendererFrom = (loaded: unknown): SvelteServerModule => {
  if (typeof loaded !== 'object' || loaded === null || !('render' in loaded) || typeof loaded.render !== 'function') {
    throw new Error('svelte/server did not expose render');
  }
  return loaded as SvelteServerModule;
};

const repositoryDirectory = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const navigationFixturePath = fileURLToPath(new URL('./sveltekit-navigation.fixture.ts', import.meta.url));
const viteServer = await createServer({
  appType: 'custom',
  configFile: false,
  optimizeDeps: { exclude: ['svelte'], noDiscovery: true },
  plugins: [svelte()],
  resolve: {
    alias: { '$app/navigation': navigationFixturePath },
    conditions: ['svelte'],
    dedupe: ['svelte'],
  },
  root: repositoryDirectory,
  server: { hmr: false, middlewareMode: true, watch: null, ws: false },
  ssr: { noExternal: true },
});
const closeViteServer = (): Promise<void> => viteServer.close();
afterAll(closeViteServer);

const [fixtureModule, hydrationFixtureModule, convergenceFixtureModule, observationsModule, svelteServerModule] =
  await Promise.all([
    viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-workspace.fixture.svelte'),
    viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-shell.hydration.fixture.svelte'),
    viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/shell/skills-convergence.fixture.svelte'),
    viteServer.ssrLoadModule('/apps/web/src/lib/features/skills/observations/skill-observations.svelte'),
    viteServer.ssrLoadModule('svelte/server'),
  ]);
const fixture = componentFrom(fixtureModule);
const hydrationFixture = componentFrom(hydrationFixtureModule);
const convergenceFixture = componentFrom(convergenceFixtureModule);
const observationsComponent = componentFrom(observationsModule);
const { render } = rendererFrom(svelteServerModule);

const presentationFor = (
  observations: SkillObservations,
  pathname = '/skills/global/alpha-skill',
  snapshot: SkillManagementSnapshot = normalizeSkillsQuerySnapshot(syntheticSnapshot()),
) =>
  createSkillsPresentationProjection({
    observations,
    observationsError: undefined,
    view: createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname,
      snapshot,
    }),
  });

const ok = <Value>(data: Value): SkillsCapabilityResult<Value> => ({ data, ok: true });
const unavailable = (): Promise<never> => Promise.reject(new Error('Synthetic unrelated service unavailable.'));
const unavailableServices = <Services>(): Services =>
  new Proxy(
    {},
    {
      get: () => unavailable,
    },
  ) as Services;

const trustedHandlerFetch = (handler: (request: Request) => Promise<Response>) => async (request: Request) => {
  const headers = new Headers(request.headers);
  headers.set('host', '127.0.0.1:4178');
  headers.set('origin', 'http://127.0.0.1:4178');
  headers.set('sec-fetch-site', 'same-origin');
  return await handler(new Request(request, { headers }));
};

/** The opening tag of the deletion group, so attribute order in the render is not load-bearing. */
const deletionGroupAttributes = (html: string): string => {
  const marker = 'data-skill-observations-group="deletion"';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error('The deletion group was not rendered.');
  }
  const openingTagStart = html.lastIndexOf('<', markerIndex);
  return html.slice(openingTagStart, html.indexOf('>', markerIndex) + 1);
};

const worktableRow = (html: string, skillName: string): string => {
  const marker = `data-worktable-row="${skillName}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`The ${skillName} worktable row was not rendered.`);
  }
  const rowStart = html.lastIndexOf('<tr', markerIndex);
  return html.slice(rowStart, html.indexOf('</tr>', markerIndex) + 5);
};

const worktableCell = (row: string, columnKey: string): string => {
  const marker = `data-worktable-cell="${columnKey}"`;
  const markerIndex = row.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`The ${columnKey} worktable cell was not rendered.`);
  }
  const cellStart = row.lastIndexOf('<td', markerIndex);
  return row.slice(cellStart, row.indexOf('</td>', markerIndex) + 5);
};

describe('Svelte Skills workspace SSR', () => {
  test('renders one worktable instead of a tree, an inspector, and a matrix page', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-skills-worktable');
    expect(html).toContain('data-worktable-group="managed"');
    expect(html).toContain('data-worktable-group="to-adopt"');
    expect(html).toContain('data-worktable-group="projects"');
    expect(html).toContain('data-worktable-group="catalogue"');
    // The three surfaces this replaced. Their absence is the point of the redesign: one row per
    // skill name, and the decision it is waiting on is which group it sits in.
    expect(html).not.toContain('data-skills-tree');
    expect(html).not.toContain('data-skills-inspector');
    expect(html).not.toContain('Skill exposure per runtime');
  });

  test('offers the decision strip as filters over the same table, not as five destinations', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    for (const filter of ['all', 'to-adopt', 'links-healthy', 'to-delete', 'catalogue-only']) {
      expect(html).toContain(`data-worktable-filter="${filter}"`);
    }
    // Filters are buttons over the rendered table. A link would reload the page and lose the scroll
    // position the reader was using to compare two rows.
    expect(html).not.toContain('href="/skills/matrix"');
  });

  test('joins a placement mark with the invocation counts of the same harness in one cell', () => {
    const html = render(convergenceFixture, {
      props: { healthSnapshot: 'management', pathname: '/skills' },
    }).body;

    // alpha-skill is missing from the Codex target and was invoked there — the join the exposure
    // matrix and the observation table each carried one half of.
    expect(html).toContain('data-worktable-cell="target:codex"');
    expect(html).toContain('Codex — to link');
    expect(html).toContain('data-evidence-tier="inferred"');
  });

  test('writes a recorded invocation as a number and a reconstructed one with a tilde', () => {
    const html = render(convergenceFixture, {
      props: { healthSnapshot: 'management', pathname: '/skills' },
    }).body;
    const normalized = html.replace(/\s+/gu, ' ');

    expect(normalized).toContain('>2<');
    expect(normalized).toContain('>~1<');
    // The abbreviations are gone from the cells, and the tier survives in words for a screen reader.
    expect(normalized).toContain('2 recorded invocations in Claude Code');
    expect(normalized).toContain('1 invocation reconstructed from traces in Codex');
    expect(normalized).not.toContain('decl 2');
    expect(normalized).not.toContain('inf 1');
  });

  test('keeps offered-to-a-model counts out of every table cell', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    // `imagegen` is exposed-only. Availability is not use, so it is folded into the catalogue group
    // and never given a count column of its own.
    expect(html).toContain('data-worktable-group="catalogue"');
    expect(html).not.toContain('exposed 1');
  });

  test('summarises each repository as one expandable row rather than a navigable empty page', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-worktable-project="project:synthetic-group"');
    expect(html).toContain('with invocation evidence — top:');
    expect(html).toContain('project-review (~4 Codex · 2 OpenCode)');
    expect(html).toContain('data-worktable-project-expand="project:synthetic-group"');
    // A project scope is a row here, so nothing routes to a page that would render empty.
    expect(html).not.toContain('href="/skills/projects/synthetic-group"');
  });

  test('renders a disabled managed skill as kept in source with its history intact', () => {
    const html = render(convergenceFixture, {
      props: { healthSnapshot: 'management', pathname: '/skills' },
    }).body;

    expect(html).toContain('data-worktable-disabled-state');
    expect(html.replace(/\s+/gu, ' ')).toContain('Kept in source');
    // Disabling removes links, never observations: the row is still in the table with its counts.
    expect(html).toContain('data-worktable-row="beta-skill"');
  });

  test('renders the adopt action disabled behind the sentence that explains the gate', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;
    const normalized = html.replace(/\s+/gu, ' ');

    expect(normalized).toContain('id="worktable-adopt-gate"');
    expect(normalized).toContain('waits on the approved file-operation plan');
  });

  test('names the harnesses that cannot report beside the strip rather than as a zero', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-harness-observability="not-observable"');
    expect(html).toContain('Cursor');
    expect(html).toContain('not observable');
  });

  test('teaches both notations once, beside the strip', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html.replace(/\s+/gu, ' ')).toContain('reconstructed from traces — never added together.');
  });

  test('keeps the page-level operations and their plan in one host', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-skills-page-actions');
    expect(html).toContain('data-skills-management-health-slot');
  });

  test('reports the observation read state on the worktable itself', () => {
    const loading = render(convergenceFixture, {
      props: { observationsError: 'Synthetic failure.', pathname: '/skills' },
    }).body;
    expect(loading).toContain('data-skill-observations-state="unavailable"');
    // A failed observation read is a failed column, not a failed page: the table still renders.
    expect(loading).toContain('data-skills-worktable');
  });

  test('masks retained worktable facts after a background refetch error', () => {
    const html = render(convergenceFixture, {
      props: {
        observationsError: 'Synthetic background refetch failure.',
        pathname: '/skills/global/alpha-skill',
        retainObservationsOnError: true,
      },
    }).body;
    const row = worktableRow(html, 'alpha-skill');

    expect(html).toContain('aria-label="All — skill observations unavailable"');
    expect(row).toContain('observations unavailable');
    expect(row).not.toContain('data-evidence-tier');
    expect(row).not.toContain('no invocation recorded');
  });

  test('renders an exact-response identity mismatch as omitted, including for assistive text', () => {
    const html = render(convergenceFixture, {
      props: {
        healthSnapshot: 'management',
        omitObservationName: 'alpha-skill',
        pathname: '/skills/global/alpha-skill',
      },
    }).body;
    const row = worktableRow(html, 'alpha-skill');
    const targetCell = worktableCell(row, 'target:codex');

    expect(row).toContain('Omitted from this observation response.');
    expect(targetCell).toContain('observation row omitted from this response');
    expect(targetCell).not.toContain('>—</span>');
    expect(row).not.toContain('no invocation recorded');
  });

  test('announces loading and unavailable observation evidence beside a placement glyph', () => {
    const cases = [
      {
        expected: 'skill observations loading',
        props: { healthSnapshot: 'management' as const, observationsLoading: true },
      },
      {
        expected: 'skill observations unavailable',
        props: { healthSnapshot: 'management' as const, observationsError: 'Synthetic failure.' },
      },
    ];

    for (const fixtureCase of cases) {
      const html = render(convergenceFixture, { props: { ...fixtureCase.props, pathname: '/skills' } }).body;
      const targetCell = worktableCell(worktableRow(html, 'alpha-skill'), 'target:codex');
      expect(targetCell).toContain(fixtureCase.expected);
      expect(targetCell).not.toContain('>—</span>');
    }
  });

  test('uses generic lower-bound copy and retained dates on the worktable', () => {
    const exposureHtml = render(convergenceFixture, {
      props: { observationsExposureTruncated: true, pathname: '/skills/global/alpha-skill' },
    }).body;
    const exposureNormalized = exposureHtml.replace(/\s+/gu, ' ');

    expect(exposureNormalized).toContain('Exposure evidence is incomplete');
    expect(exposureNormalized).toContain('latest retained 2026-08-02');
    expect(exposureNormalized).not.toContain('stopped short');
    expect(exposureNormalized).not.toContain('reached its bound');

    const invocationHtml = render(convergenceFixture, {
      props: { observationsProvisional: true, pathname: '/skills/global/alpha-skill' },
    }).body;
    const invocationNormalized = invocationHtml.replace(/\s+/gu, ' ');
    expect(invocationNormalized).toContain('Observation evidence is incomplete');
    expect(invocationNormalized).toContain('at least 2 recorded');
    expect(invocationNormalized).toContain('aria-label="To delete — 1 provisional managed deletion candidates"');
    expect(invocationNormalized).not.toContain('reached its bound');
  });

  test('composes the editor and page-action slots through one shell context', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-skills-management-health-slot');
    expect(html).toContain('data-skills-worktable');
  });

  test('qualifies a bounded read on the worktable without hedging the whole page', () => {
    const html = render(convergenceFixture, {
      props: { observationsProvisional: true, pathname: '/skills' },
    }).body;

    expect(html).toContain('data-skill-observations-lower-bound="invocations"');
  });

  test('explains why current producer state is unavailable', () => {
    const html = render(convergenceFixture, {
      props: { producerCompletenessMissing: true, pathname: '/skills' },
    }).body;

    expect(html).toContain('data-skill-observations-collection-pending');
    expect(html).toContain('data-skill-observations-lower-bound="invocations"');
  });

  test('reports skipped stored observations on the worktable', () => {
    const html = render(convergenceFixture, { props: { observationsSkipped: 2, pathname: '/skills' } }).body;

    expect(html).toContain('data-skill-observations-skipped');
    expect(html.replace(/\s+/gu, ' ')).toContain('2 stored observations could not be read and are not counted.');
  });

  test('discloses name scope on the worktable itself', () => {
    const html = render(convergenceFixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-worktable-name-scope');
    expect(html.replace(/\s+/gu, ' ')).toContain(
      'Counts are name-scoped and cover every installation sharing the name.',
    );
  });

  test('renders the worktable from settled data alone, with no query client mounted', () => {
    const html = render(fixture, { props: { pathname: '/skills' } }).body;

    expect(html).toContain('data-skills-worktable');
    expect(html).toContain('data-worktable-group="managed"');
    expect(html).toContain('alpha-skill');
  });

  test('keeps configuration and the unmanaged backlog below the table instead of on another page', () => {
    const html = render(convergenceFixture, {
      props: { healthSnapshot: 'management', pathname: '/skills' },
    }).body;

    expect(html).toContain('data-skills-configuration');
    expect(html).toContain('Configuration &amp; runtimes');
    expect(html).toContain('Source repository');
    expect(html).toContain('value="/synthetic/source"');
    expect(html).toContain('data-consolidation-panel');
    expect(html).toContain('data-backlog-tone="neutral"');
    expect(html).toContain('legacy-local-copy');
    expect(html).toContain('Nothing is ever deleted automatically.');
    // The matrix was the old second destination for this backlog; there is no second destination.
    expect(html).not.toContain('Review in the matrix');
  });

  test('does not state absolute invocation absence for an unmanaged entry when history is incomplete', () => {
    const html = render(convergenceFixture, {
      props: { healthSnapshot: 'management', observationsProvisional: true, pathname: '/skills' },
    }).body;

    expect(html).toContain('no invocation in loaded history');
    expect(html).not.toContain('never observed');
  });

  test('tells a truncated catalogue apart from truncated evidence instead of hedging both', () => {
    const html = render(observationsComponent, {
      props: {
        observationPresentation: presentationFor(syntheticExposureTruncatedObservations).observations,
        variant: 'overview',
      },
    }).body;

    // A real store is permanently in this state, so flattening it into "the read reached its bound"
    // meant every verdict carried a hedge that could never come off — which is how a store holding
    // hundreds of real invocations came to read as if nothing had ever been invoked.
    expect(html).toContain('data-skill-observations-lower-bound="exposure"');
    expect(html.replace(/\s+/gu, ' ')).toContain('Invocation verdicts are not affected.');
    expect(html).toContain('Latest retained signal');
    expect(deletionGroupAttributes(html)).toContain('data-provisional="false"');
    expect(html).not.toContain('within the read bound');

    const evidenceBounded = render(observationsComponent, {
      props: {
        observationPresentation: presentationFor(syntheticProvisionalObservations).observations,
        variant: 'overview',
      },
    }).body;
    expect(evidenceBounded).toContain('data-skill-observations-lower-bound="invocations"');
    expect(evidenceBounded).toContain('no invocation in loaded history');
    expect(deletionGroupAttributes(evidenceBounded)).toContain('data-provisional="true"');

    const detail = (observations: SkillObservations): string => {
      const presentation = presentationFor(observations);
      return render(observationsComponent, {
        props: {
          observationPresentation: presentation.observations,
          selectedPresentation: presentation.selected,
          variant: 'skill',
        },
      }).body;
    };
    const detailExposureBounded = detail(syntheticExposureTruncatedObservations);
    expect(detailExposureBounded).toContain('data-skill-observations-lower-bound="exposure"');
    expect(detailExposureBounded.replace(/\s+/gu, ' ')).toContain('Invocation verdicts are not affected.');
    expect(detailExposureBounded).toContain('Latest retained signal');

    const detailEvidenceBounded = detail(syntheticProvisionalObservations);
    expect(detailEvidenceBounded).toContain('data-skill-observations-lower-bound="invocations"');
    expect(detailEvidenceBounded).toContain('Observation evidence is incomplete');
    expect(detailEvidenceBounded).toContain('Latest retained signal');
  });

  test('reports skipped stored observations on a selected skill detail', () => {
    const presentation = presentationFor({ ...syntheticExposureTruncatedObservations, skipped: 2 });
    const html = render(observationsComponent, {
      props: {
        observationPresentation: presentation.observations,
        selectedPresentation: presentation.selected,
        variant: 'skill',
      },
    }).body;

    expect(html).toContain('data-skill-observations-skipped');
    expect(html.replace(/\s+/gu, ' ')).toContain('2 stored observations could not be read and are not counted.');
  });

  test('reports skipped stored observations on global and project overview surfaces', () => {
    for (const pathname of ['/skills/global', '/skills/projects/synthetic-group']) {
      const html = render(convergenceFixture, { props: { observationsSkipped: 2, pathname } }).body;

      expect(html).toContain('data-skill-observations-skipped');
      expect(html.replace(/\s+/gu, ' ')).toContain('2 stored observations could not be read and are not counted.');
    }
  });

  test('renders the resolved-path ceiling as words rather than a silently short list', () => {
    const withTruncatedPaths: SkillObservations = {
      ...syntheticObservations,
      skills: syntheticObservations.skills.map((skill) =>
        skill.skillName === 'alpha-skill'
          ? {
              ...skill,
              resolvedPaths: [...skill.resolvedPaths, '/synthetic/other/alpha-skill'],
              resolvedPathsTruncated: true,
            }
          : skill,
      ),
    };
    const detail = (observations: SkillObservations): string => {
      const presentation = presentationFor(observations);
      return render(observationsComponent, {
        props: {
          observationPresentation: presentation.observations,
          selectedPresentation: presentation.selected,
          variant: 'skill',
        },
      }).body;
    };

    const truncated = detail(withTruncatedPaths);
    expect(truncated).toContain('data-skill-observations-resolved-paths-truncated');
    expect(truncated).toContain('Showing 2 directories — the name resolved to more than this list carries.');

    // A complete list says nothing, so the note never reads as a permanent caveat on every skill.
    const complete = detail(syntheticObservations);
    expect(complete).toContain('/synthetic/source/skills/alpha-skill');
    expect(complete).not.toContain('data-skill-observations-resolved-paths-truncated');
  });

  test('qualifies the deletion sentence on a skill detail, which is the claim a maintainer acts on', () => {
    const detail = (observations: SkillObservations): string => {
      const presentation = presentationFor(observations, '/skills/global/beta-skill', syntheticManagementSnapshot());
      return render(observationsComponent, {
        props: {
          observationPresentation: presentation.observations,
          selectedPresentation: presentation.selected,
          variant: 'skill',
        },
      }).body;
    };

    const complete = detail(syntheticObservations);
    expect(complete).toContain('data-skill-observations-deletion-candidate');
    expect(complete).toContain(
      'Installed in every enabled runtime, with no invocation recorded — a deletion candidate.',
    );

    // Same skill, same verdict, a read that could not establish the absence it rests on. Proposing a
    // deletion is the one verdict acted on destructively, so it must not be phrased as established.
    const provisional = detail(syntheticProvisionalObservations);
    expect(provisional).toContain(
      'Installed in every enabled runtime, with no invocation in loaded history — a provisional deletion candidate.',
    );
    expect(provisional).not.toContain('no invocation recorded');
    // The group heading already says "every enabled runtime"; both sentences describe one rule.
    expect(provisional).not.toContain('Installed in every runtime');
  });

  test('reports an unavailable observation read per metric instead of as a page banner', () => {
    const html = render(convergenceFixture, {
      props: { observationsError: 'Skill observations are unavailable.', pathname: '/skills' },
    }).body;

    expect(html).toContain('data-skill-observations-state="unavailable"');
    // The rest of the page still renders its own numbers; nothing global was flagged.
    expect(html).toContain('data-worktable-filter="links-healthy"');
    expect(html).not.toContain('data-skill-observations="overview"');
  });

  test('hydrates a bounded awaited route into a new provider without duplicate Skills acquisition', async () => {
    const calls = { acquisitions: 0, inventories: 0, knownPaths: 0, managed: 0, observations: 0, snapshot: 0 };
    const baseSnapshot = syntheticSnapshot();
    const snapshot = { ...baseSnapshot, config: { ...baseSnapshot.config, sourceRepoPath: '/fixture/source' } };
    const capability: SkillsCapability = {
      createTargetDirectory: unavailable,
      previewReconcileAll: unavailable,
      readKnownProjectPaths: () => {
        calls.knownPaths += 1;
        return ok([...syntheticKnownPaths]);
      },
      readMarkdown: () => {
        calls.managed += 1;
        return ok(syntheticManagedDocument);
      },
      readObservations: () => {
        calls.observations += 1;
        return ok(syntheticObservations);
      },
      readProjectInventories: () => {
        calls.inventories += 1;
        return ok([...syntheticInventories]);
      },
      readProjectMarkdown: () => ok(syntheticProjectDocument),
      readSnapshot: () => {
        calls.snapshot += 1;
        return ok(snapshot);
      },
      reconcileAll: unavailable,
      reconcileSkill: unavailable,
      refreshSnapshot: unavailable,
      saveConfig: unavailable,
      saveMarkdown: unavailable,
      toggleSkill: unavailable,
    };
    const handler = createWebRpcHttpHandler({
      createDependencies: () => {
        calls.acquisitions += 1;
        return Promise.resolve({
          report: unavailableServices<WebRpcRouterDependencies['report']>(),
          session: unavailableServices<WebRpcRouterDependencies['session']>(),
          skills: {
            preflight: () => ({ allowed: true }),
            selectCapability: () => capability,
          },
          sync: unavailableServices<WebRpcRouterDependencies['sync']>(),
        });
      },
    });
    const result = await loadSkillsShellRoute({
      mode: 'e2e',
      options: {
        fetch: trustedHandlerFetch(handler),
        requestOwner: 'p5-hydration-fixture',
        url: new URL('http://127.0.0.1:4178/skills/global/alpha-skill'),
      },
      pathname: '/skills/global/alpha-skill',
    });
    if (result.decision !== 'render') {
      throw new Error('The live Skills hydration fixture must render.');
    }
    const callsAfterRoute = { ...calls };
    const html = render(hydrationFixture, {
      props: { hydrationState: result.queryState, source: result.source },
    }).body;

    expect(html).toContain('data-skills-workspace');
    expect(html).toContain('Source /fixture/source');
    expect(html).not.toContain('Source not configured');
    expect(html).toContain('alpha-skill');
    expect(html).toContain('data-skills-worktable');
    expect(html).not.toContain('Loading skills');
    expect(callsAfterRoute).toEqual({
      acquisitions: 5,
      inventories: 1,
      knownPaths: 1,
      managed: 1,
      observations: 1,
      snapshot: 1,
    });
    expect(calls).toEqual(callsAfterRoute);
  });
});
