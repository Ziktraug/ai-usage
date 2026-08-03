import { currentRecord } from '../helpers';
import { defineParityShard, type UrlContractDescriptor } from '../schema';

const owner = 'R0' as const;
const implementationCommit = '435aa06e595405ce384338db5106a902e99443ce';
const correctionCommit = '98235abf62fc5d5e709a75581557d4449cd8f2c0';
const targetReferences = (id: string): { readonly source: string; readonly test: string } => {
  if (id.startsWith('url:dashboard.')) {
    return {
      source:
        'apps/web/src/lib/foundation/navigation/svelte/dashboard-url.ts; apps/web/src/lib/foundation/navigation/svelte/search-codec.ts',
      test: 'apps/web/src/lib/foundation/navigation/svelte/dashboard-url.test.ts; apps/web/src/lib/foundation/navigation/svelte/search-codec.test.ts',
    };
  }
  if (id.startsWith('url:skills.')) {
    return {
      source: 'apps/web/src/lib/foundation/navigation/svelte/skills-url.ts',
      test: 'apps/web/src/lib/foundation/navigation/svelte/skills-url.test.ts',
    };
  }
  return {
    source:
      'apps/web/src/lib/foundation/navigation/svelte/navigation.ts; apps/web/src/lib/foundation/navigation/svelte/dirty-navigation.ts',
    test: 'apps/web/src/lib/foundation/navigation/svelte/navigation.test.ts; apps/web/src/lib/foundation/navigation/svelte/dirty-navigation.test.ts',
  };
};
const correctionReferences = (id: string): { readonly source: string; readonly test: string } => {
  if (id.startsWith('url:dashboard.')) {
    return targetReferences(id);
  }
  if (id.startsWith('url:skills.')) {
    return {
      source:
        id === 'url:skills.matrix'
          ? 'apps/web/src/lib/foundation/navigation/svelte/skills-url.ts; apps/web/src/lib/foundation/navigation/svelte/dirty-navigation.ts'
          : 'apps/web/src/lib/foundation/navigation/svelte/skills-url.ts',
      test: 'apps/web/src/lib/foundation/navigation/svelte/skills-url.test.ts',
    };
  }
  if (id === 'url:session.drawer-identity') {
    return {
      source: 'apps/web/src/lib/foundation/navigation/svelte/navigation.ts#createDrawerIdentityOwner',
      test: 'apps/web/src/lib/foundation/navigation/svelte/navigation.test.ts',
    };
  }
  return {
    source:
      'apps/web/src/lib/foundation/navigation/svelte/navigation.ts; apps/web/src/lib/foundation/navigation/svelte/dirty-navigation.ts; apps/web/src/lib/foundation/navigation/svelte/retry.ts',
    test: 'apps/web/src/lib/foundation/navigation/svelte/navigation.test.ts; apps/web/src/lib/foundation/navigation/svelte/dirty-navigation.test.ts; apps/web/src/lib/foundation/navigation/svelte/retry.test.ts',
  };
};
const urlRecord = (id: string, currentOwner: string, urlContract: UrlContractDescriptor, tests: readonly string[]) =>
  currentRecord(
    owner,
    (() => {
      const target = targetReferences(id);
      const correction = correctionReferences(id);
      return {
        currentOwner,
        evidence: [
          ...tests.map((reference) => ({ kind: 'test' as const, reference })),
          { commit: implementationCommit, kind: 'source' as const, phase: 'target' as const, reference: target.source },
          { commit: implementationCommit, kind: 'test' as const, phase: 'target' as const, reference: target.test },
          { commit: correctionCommit, kind: 'source' as const, phase: 'target' as const, reference: correction.source },
          {
            commit: correctionCommit,
            kind: 'test' as const,
            phase: 'target' as const,
            reference: `${correction.test}; exact [${id}] target test title`,
          },
        ],
        id,
        kind: 'url-contract' as const,
        urlContract,
      };
    })(),
  );

const dashboardOwner = 'apps/web/src/dashboard-search.ts; apps/web/src/dashboard-navigation-controller.ts';
const dashboardTests = ['apps/web/src/dashboard-search.test.ts', 'apps/web/e2e/dashboard.spec.ts'];
const skillsOwner = 'apps/web/src/skills-page-model.ts; apps/web/src/skills-selection-link.tsx';
const skillsTests = ['apps/web/src/skills-page-model.test.ts', 'apps/web/e2e/skills.spec.ts'];

export default defineParityShard({
  owner,
  records: [
    urlRecord(
      'url:dashboard.tab',
      dashboardOwner,
      {
        canonical: 'tab=overview|sessions|models|harness-providers|projects|cursor-ai',
        defaultValue: 'overview (stripped)',
        legacyValues: ['providers', 'harnesses (retained in the URL and projected to harness-providers)'],
        lifecycle: 'Primary and Breakdown navigation pushes history without resetting scroll.',
      },
      dashboardTests,
    ),
    urlRecord(
      'url:dashboard.breakdown-sort',
      dashboardOwner,
      {
        canonical: 'breakdownSort=value|tokens|sessions',
        defaultValue: 'value (stripped)',
        legacyValues: ['unsupported values fall back to value'],
        lifecycle: 'A user sort selection pushes one navigation entry.',
      },
      dashboardTests,
    ),
    urlRecord(
      'url:dashboard.query',
      dashboardOwner,
      {
        canonical: 'q=<trimmed text>',
        defaultValue: 'empty string (stripped)',
        legacyValues: ['non-string values become empty'],
        lifecycle:
          'The first edit pushes; continuing edits replace; commit ends the replace run; reload restores the value.',
      },
      dashboardTests,
    ),
    urlRecord(
      'url:dashboard.harness',
      dashboardOwner,
      {
        canonical: 'harness=<JSON array of unique non-empty strings>',
        defaultValue: '[] (stripped)',
        legacyValues: ['bare string becomes one item', 'all sentinel becomes no filter'],
        lifecycle: 'Selection and removal push history; unrelated parameters survive.',
      },
      dashboardTests,
    ),
    urlRecord(
      'url:dashboard.machine',
      dashboardOwner,
      {
        canonical: 'machine=<JSON array of unique non-empty raw identities>',
        defaultValue: '[] (stripped)',
        legacyValues: ['bare string becomes one item', 'all sentinel becomes no filter'],
        lifecycle: 'Selection/removal pushes and preserves raw stale-machine identity.',
      },
      [...dashboardTests, 'apps/web/e2e/machine-staleness.spec.ts'],
    ),
    urlRecord(
      'url:dashboard.origin',
      dashboardOwner,
      {
        canonical: 'origin=<ordered JSON subset of human|subagent|classifier|unknown>',
        defaultValue: '[] neutral selection (stripped)',
        legacyValues: ['bare string accepted', 'all four values canonicalize to []', 'invalid-only falls back'],
        lifecycle: 'Selection/removal pushes; legacy links retain neutral origin semantics.',
      },
      [...dashboardTests, 'apps/web/e2e/origin-campaign.spec.ts'],
    ),
    urlRecord(
      'url:dashboard.field-filters',
      dashboardOwner,
      {
        canonical: 'filters={campaign|provider|model|project:<trimmed exact value>}',
        defaultValue: '{} (stripped)',
        legacyValues: [
          'unknown keys and empty values are dropped',
          'campaign: display prefix is removed by navigation intent',
        ],
        lifecycle: 'Exact selection toggles and pushes without disturbing other dimensions.',
      },
      [...dashboardTests, 'apps/web/src/dashboard-filter-navigation.test.ts'],
    ),
    urlRecord(
      'url:dashboard.range',
      dashboardOwner,
      {
        canonical: 'range={mode:all|today|7d|30d|custom,from?:YYYY-MM-DD,to?:YYYY-MM-DD}',
        defaultValue: '{mode:30d} (stripped)',
        legacyValues: ['invalid/impossible/reversed custom bounds fall back', 'missing custom bounds remain open'],
        lifecycle: 'Preset, text, keyboard, pointer, heatmap, and Punchcard commits push canonical history.',
      },
      [...dashboardTests, 'apps/web/e2e/time-range.spec.ts'],
    ),
    urlRecord(
      'url:dashboard.time-cell',
      dashboardOwner,
      {
        canonical: 'timeCell=MON..SUN-00..23',
        defaultValue: 'absent',
        legacyValues: ['lowercase, short hour, out-of-range, suffixed, and array values are dropped'],
        lifecycle: 'Punchcard click/keyboard selection pushes; removal deletes only timeCell.',
      },
      [...dashboardTests, 'apps/web/e2e/time-range.spec.ts'],
    ),
    urlRecord(
      'url:dashboard.sort',
      dashboardOwner,
      {
        canonical: 'sort={id:<25-column ID>,desc:boolean}',
        defaultValue: '{id:date,desc:true} for the root report (stripped)',
        legacyValues: ['one-element array is accepted', 'invalid IDs fall back', 'missing desc inherits the default'],
        lifecycle: 'Table sorting pushes and retains the exact visible column identity.',
      },
      dashboardTests,
    ),
    urlRecord(
      'url:dashboard.columns',
      dashboardOwner,
      {
        canonical: 'cols=<unique searchable column-diff IDs>&colsBase=auto|work|legacy',
        defaultValue: 'cols=[] and colsBase=auto (stripped)',
        legacyValues: [
          'unversioned cols use auto; empty resolves to work while non-empty resolves to legacy',
          'explicit colsBase=work and colsBase=legacy remain valid; invalid IDs are dropped',
        ],
        lifecycle: 'Visibility changes replace the current history entry and never reset scroll.',
      },
      [...dashboardTests, 'apps/web/src/session-table-schema.test.ts'],
    ),
    urlRecord(
      'url:skills.global-scope',
      skillsOwner,
      {
        canonical: '/skills/global',
        defaultValue: '/skills redirects/replaces to /skills/global when no selection exists',
        legacyValues: ['/skills/matrix maps to global scope for tree selection while retaining the matrix route'],
        lifecycle: 'Tree navigation preserves scroll and the stable selection key global.',
      },
      skillsTests,
    ),
    urlRecord(
      'url:skills.global-skill',
      skillsOwner,
      {
        canonical: '/skills/global/<encoded skillName>',
        defaultValue: 'no selected document at global scope',
        legacyValues: ['decoded route segment is retained as the skill name'],
        lifecycle: 'Direct link/reload selects the same editable document; dirty-draft guard may cancel navigation.',
      },
      skillsTests,
    ),
    urlRecord(
      'url:skills.matrix',
      skillsOwner,
      {
        canonical: '/skills/matrix',
        defaultValue: 'not selected',
        legacyValues: ['/skills/matrix has global tree scope but a distinct matrix destination'],
        lifecycle: 'Matrix navigation pushes and preserves scroll unless the draft guard cancels it.',
      },
      skillsTests,
    ),
    urlRecord(
      'url:skills.project-scope',
      skillsOwner,
      {
        canonical: '/skills/projects/<encoded opaque group/source key or unique basename>',
        defaultValue: 'no selected project',
        legacyValues: ['unique basename links resolve', 'colliding basenames require the full stable path/key'],
        lifecycle: 'Label renames do not change opaque route keys; direct/reload selection is stable.',
      },
      skillsTests,
    ),
    urlRecord(
      'url:skills.project-skill',
      skillsOwner,
      {
        canonical: '/skills/projects/<encoded projectKey>/<encoded skillName>',
        defaultValue: 'no selected project document',
        legacyValues: ['unique legacy basename project keys resolve against known projects'],
        lifecycle: 'Direct/reload selects the same source document; dirty-draft guard owns keep/discard/cancel.',
      },
      skillsTests,
    ),
    urlRecord(
      'url:session.drawer-identity',
      'apps/web/src/dashboard-session-selection.ts; apps/web/src/shared.tsx#rowKey',
      {
        canonical:
          'Wave-0 drawer identity is local rowKey plus exact served revision/campaign key; it is not a query parameter.',
        defaultValue: 'closed with null key/revision/target',
        legacyValues: ['colliding row IDs are disambiguated by exact campaign key'],
        lifecycle:
          'Selection survives virtualization; j/k or arrows use exact neighbors; Escape closes without changing the active report tab.',
      },
      ['apps/web/src/dashboard-session-selection.test.ts', 'apps/web/e2e/dashboard.spec.ts › drawer cases'],
    ),
    urlRecord(
      'url:history.replace-push-back-forward',
      'apps/web/src/dashboard-navigation-controller.ts; apps/web/src/skills-workspace.tsx',
      {
        canonical:
          'All adapters preserve unrelated search parameters and resetScroll=false unless an explicit route transition says otherwise.',
        defaultValue: 'push for discrete intent; replace for ongoing text/column edits and /skills fallback',
        legacyValues: ['numeric history -1/+1 remains browser-owned and must not be emulated by rewriting URLs'],
        lifecycle:
          'Back/forward restores parsed snapshots without feedback loops; draft cancellation leaves the current entry untouched.',
      },
      ['apps/web/src/dashboard-search.test.ts', 'apps/web/e2e/dashboard.spec.ts', 'apps/web/e2e/skills.spec.ts'],
    ),
  ],
});
