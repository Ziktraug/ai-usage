<script lang="ts">
  import { css, cx } from '@ai-usage/design-system/css';
  import { panel, panelSub, panelTitle } from '@ai-usage/design-system/svelte';
  import type { KnownProjectScope, SkillSelection, SkillTreeModel } from '../../../../skills-page-model';
  import { selectionKey } from '../../../../skills-page-model';
  import SelectionLink from './selection-link.svelte';

  let {
    idPrefix = 'skill',
    knownProjects,
    model,
    selection,
  }: {
    idPrefix?: string;
    knownProjects: readonly KnownProjectScope[];
    model: SkillTreeModel;
    selection: SkillSelection;
  } = $props();

  let query = $state('');
  let expandedKeys = $state<ReadonlySet<string>>(new Set(['global']));
  let collapsedKeys = $state<ReadonlySet<string>>(new Set());
  const normalizedQuery = $derived(query.trim().toLowerCase());
  const visibleScopes = $derived(
    model.scopes
      .map((scope) => {
        if (!normalizedQuery) {
          return scope;
        }
        const scopeMatches =
          scope.label.toLowerCase().includes(normalizedQuery) ||
          (scope.path?.toLowerCase().includes(normalizedQuery) ?? false);
        const skills = scope.skills.filter(
          (skill) =>
            scopeMatches ||
            skill.name.toLowerCase().includes(normalizedQuery) ||
            skill.description.toLowerCase().includes(normalizedQuery),
        );
        return scopeMatches || skills.length > 0 ? { ...scope, skills } : undefined;
      })
      .filter((scope) => scope !== undefined),
  );
  const emptyScopes = $derived(
    normalizedQuery
      ? model.emptyScopes.filter(
          (scope) =>
            scope.label.toLowerCase().includes(normalizedQuery) ||
            (scope.path?.toLowerCase().includes(normalizedQuery) ?? false),
        )
      : model.emptyScopes,
  );
  const activeKey = $derived(selectionKey(selection));
  const activeScopeKey = $derived(
    selection.type === 'global-scope' || selection.type === 'global-skill'
      ? 'global'
      : selectionKey({ projectPath: selection.projectPath, type: 'project-scope' }),
  );

  const treePanel = css({
    alignSelf: 'start',
    position: { base: 'static', lg: 'sticky' },
    top: '16px',
    maxH: { base: 'none', lg: 'calc(100vh - 32px)' },
    overflow: 'auto',
  });
  const panelHeader = css({ display: 'grid', gap: '4px', mb: '12px' });
  const treeStack = css({ display: 'grid', gap: '12px', mt: '12px' });
  const scopeGroup = css({ display: 'grid', gap: '6px' });
  const scopeRow = css({ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: '4px' });
  const searchInput = css({
    w: '100%',
    h: '36px',
    px: '10px',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    bg: 'surface',
    color: 'ink',
  });
  const treeButton = css({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '8px',
    minW: 0,
    p: '8px 10px',
    border: '1px solid transparent',
    borderRadius: 'sm',
    color: 'ink',
    textDecoration: 'none',
    _hover: { bg: 'surfaceMuted', borderColor: 'line' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
    '&[data-selected="true"]': { bg: 'accentTint', borderColor: 'accent' },
  });
  const skillButton = css({ pl: '36px' });
  const toggleButton = css({
    border: '1px solid transparent',
    borderRadius: 'sm',
    bg: 'transparent',
    color: 'muted',
    cursor: 'pointer',
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const label = css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
  const count = css({ color: 'muted', fontSize: '11px', fontWeight: 650 });
  const attention = css({ color: 'status.warn', fontSize: '11px', fontWeight: 700 });
  const emptySummary = css({ color: 'muted', cursor: 'pointer', fontSize: '13px', fontWeight: 650 });
  const filterInfo = css({ color: 'muted', fontSize: '12px', lineHeight: 1.5 });

  const toggleScope = (scopeKey: string): void => {
    const isExpanded =
      normalizedQuery.length > 0 ||
      (!collapsedKeys.has(scopeKey) && (expandedKeys.has(scopeKey) || activeScopeKey === scopeKey));
    const nextExpanded = new Set(expandedKeys);
    const nextCollapsed = new Set(collapsedKeys);
    if (isExpanded) {
      nextExpanded.delete(scopeKey);
      nextCollapsed.add(scopeKey);
    } else {
      nextCollapsed.delete(scopeKey);
      nextExpanded.add(scopeKey);
    }
    expandedKeys = nextExpanded;
    collapsedKeys = nextCollapsed;
  };
</script>

<aside aria-label="Skill scopes" class={cx(panel, treePanel)}>
  <div class={panelHeader}>
    <h2 class={panelTitle}>Skills</h2>
    <p class={panelSub}>Global and project scopes</p>
  </div>
  <input
    aria-label="Filter scopes and skills"
    class={searchInput}
    placeholder="Filter scopes or skills..."
    bind:value={query}
  >
  <div class={treeStack}>
    {#if visibleScopes.length + emptyScopes.length === 0}
      <p class={filterInfo}>No scopes or skills match this filter.</p>
    {:else}
      {#each visibleScopes as scope (scope.key)}
        {@const listId = `${idPrefix}-scope-${scope.key.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`}
        {@const expanded =
          normalizedQuery.length > 0 ||
          (!collapsedKeys.has(scope.key) && (expandedKeys.has(scope.key) || activeScopeKey === scope.key))}
        <section class={scopeGroup}>
          <div class={scopeRow}>
            {#if expanded}
              <button
                aria-controls={listId}
                aria-expanded="true"
                aria-label={`Collapse ${scope.label}`}
                class={toggleButton}
                onclick={() => toggleScope(scope.key)}
                type="button"
              >
                ▾
              </button>
            {:else}
              <button
                aria-controls={listId}
                aria-expanded="false"
                aria-label={`Expand ${scope.label}`}
                class={toggleButton}
                onclick={() => toggleScope(scope.key)}
                type="button"
              >
                ▸
              </button>
            {/if}
            <SelectionLink
              class={treeButton}
              {knownProjects}
              selected={activeKey === scope.key}
              selection={scope.selection}
              title={scope.path}
            >
              <span class={label}>{scope.label}</span><span class={count}>{scope.skills.length}</span>
            </SelectionLink>
          </div>
          {#if expanded}
            <div id={listId}>
              {#each scope.skills as skill (skill.key)}
                <SelectionLink
                  class={cx(treeButton, skillButton)}
                  {knownProjects}
                  selected={activeKey === skill.key}
                  selection={skill.selection}
                  title={skill.description || skill.name}
                >
                  <span class={label}>{skill.name}</span>
                  {#if skill.issueCount > 0 || skill.validationStatus === 'invalid'}
                    <span class={attention} title={skill.attentionSummary || undefined}>
                      {skill.validationStatus === 'invalid' ? '!' : skill.issueCount}
                    </span>
                  {/if}
                </SelectionLink>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
      {#if emptyScopes.length > 0}
        <details>
          <summary class={emptySummary}>Projects without skills ({emptyScopes.length})</summary>
          {#each emptyScopes as scope (scope.key)}
            <SelectionLink
              class={treeButton}
              {knownProjects}
              selected={activeKey === scope.key}
              selection={scope.selection}
              title={scope.path}
            >
              <span class={label}>{scope.label}</span><span class={count}>0</span>
            </SelectionLink>
          {/each}
        </details>
      {/if}
    {/if}
  </div>
</aside>
