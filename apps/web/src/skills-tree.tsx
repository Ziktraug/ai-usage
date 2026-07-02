import { css, cx } from '@ai-usage/design-system/css';
import {
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  searchInput,
  statusPill,
  statusPillDanger,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import { createMemo, For, Show } from 'solid-js';
import { type KnownProjectScope, type SkillSelection, type SkillTreeModel, selectionKey } from './skills-page-model';
import { SkillSelectionLink } from './skills-selection-link';

const treePanel = css({
  alignSelf: 'start',
  position: { base: 'static', lg: 'sticky' },
  top: '16px',
  maxH: { base: 'none', lg: 'calc(100vh - 32px)' },
  overflow: 'auto',
});

const treeStack = css({
  display: 'grid',
  gap: '12px',
});

const scopeGroup = css({
  display: 'grid',
  gap: '6px',
});

const scopeRow = css({
  display: 'grid',
  gridTemplateColumns: '32px minmax(0, 1fr)',
  gap: '4px',
  alignItems: 'stretch',
});

const treeButton = css({
  appearance: 'none',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  w: '100%',
  minW: 0,
  p: '8px 10px',
  border: '1px solid transparent',
  borderRadius: 'sm',
  bg: 'transparent',
  color: 'ink',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: {
    bg: 'surfaceMuted',
    borderColor: 'line',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
  '&[data-selected="true"]': {
    bg: 'accentTint',
    borderColor: 'accent',
  },
});

const toggleButton = css({
  appearance: 'none',
  display: 'grid',
  placeItems: 'center',
  minW: 0,
  border: '1px solid transparent',
  borderRadius: 'sm',
  bg: 'transparent',
  color: 'muted',
  cursor: 'pointer',
  _hover: {
    bg: 'surfaceMuted',
    borderColor: 'line',
  },
  _focusVisible: {
    outline: '2px solid token(colors.accent)',
    outlineOffset: '2px',
  },
});

const skillButton = css({
  pl: '36px',
});

const nodeLabel = css({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const scopeLabel = css({
  display: 'flex',
  minW: 0,
  gap: '6px',
  alignItems: 'baseline',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

const scopePath = css({
  color: 'muted',
  fontSize: '12px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const subtleCount = css({
  color: 'muted',
  fontSize: '11px',
  fontWeight: 650,
});

const attentionPill = css({
  minW: '22px',
  justifyContent: 'center',
});

const emptyFold = css({
  display: 'grid',
  gap: '6px',
});

const emptySummary = css({
  color: 'muted',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 650,
  listStyle: 'none',
  _marker: {
    display: 'none',
  },
});

const filterInfo = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
});

const statusClass = (validationStatus?: string) => (validationStatus === 'invalid' ? statusPillDanger : statusPillWarn);

export const SkillsTree = (props: {
  expandedKeys: ReadonlySet<string>;
  knownProjects: readonly KnownProjectScope[];
  model: SkillTreeModel;
  onQueryChange: (value: string) => void;
  onToggleScope: (scopeKey: string) => void;
  query: string;
  selection: SkillSelection;
}) => {
  const activeKey = createMemo(() => selectionKey(props.selection));
  const normalizedQuery = createMemo(() => props.query.trim().toLowerCase());
  const scopes = createMemo(() => {
    const query = normalizedQuery();
    if (!query) {
      return props.model.scopes;
    }
    return props.model.scopes
      .map((scope) => {
        const scopeMatches =
          scope.label.toLowerCase().includes(query) || (scope.path?.toLowerCase().includes(query) ?? false);
        const skills = scope.skills.filter(
          (skill) =>
            scopeMatches || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query),
        );
        return scopeMatches || skills.length > 0 ? { ...scope, skills } : undefined;
      })
      .filter((scope) => scope !== undefined);
  });
  const emptyScopes = createMemo(() => {
    const query = normalizedQuery();
    if (!query) {
      return props.model.emptyScopes;
    }
    return props.model.emptyScopes.filter(
      (scope) => scope.label.toLowerCase().includes(query) || (scope.path?.toLowerCase().includes(query) ?? false),
    );
  });
  const hasVisibleScopes = createMemo(() => scopes().length + emptyScopes().length > 0);

  return (
    <aside aria-label="Skill scopes" class={cx(panel, treePanel)}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Skills</h2>
        <p class={panelSub}>Global and project scopes</p>
      </div>
      <input
        aria-label="Filter scopes and skills"
        class={searchInput}
        onInput={(event) => props.onQueryChange(event.currentTarget.value)}
        placeholder="Filter scopes or skills..."
        value={props.query}
      />
      <div class={treeStack}>
        <Show fallback={<p class={filterInfo}>No scopes or skills match this filter.</p>} when={hasVisibleScopes()}>
          <For each={scopes()}>
            {(scope) => (
              <section class={scopeGroup}>
                {(() => {
                  const listId = `skill-scope-${scope.key.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
                  const expanded = () => normalizedQuery().length > 0 || props.expandedKeys.has(scope.key);
                  return (
                    <>
                      <div class={scopeRow}>
                        <button
                          aria-controls={listId}
                          aria-expanded={expanded()}
                          aria-label={`${expanded() ? 'Collapse' : 'Expand'} ${scope.label}`}
                          class={toggleButton}
                          onClick={() => props.onToggleScope(scope.key)}
                          type="button"
                        >
                          {expanded() ? '▾' : '▸'}
                        </button>
                        <SkillSelectionLink
                          class={treeButton}
                          knownProjects={props.knownProjects}
                          selected={activeKey() === scope.key}
                          selection={scope.selection}
                          title={scope.path}
                        >
                          <span class={scopeLabel}>
                            <span class={strongCell}>{scope.label}</span>
                            <Show when={scope.shortPath}>
                              {(shortPath) => <span class={scopePath}>{shortPath()}</span>}
                            </Show>
                          </span>
                          <span class={subtleCount}>{scope.skills.length}</span>
                        </SkillSelectionLink>
                      </div>
                      <Show when={expanded()}>
                        <div id={listId}>
                          <For each={scope.skills}>
                            {(skill) => (
                              <SkillSelectionLink
                                class={cx(treeButton, skillButton)}
                                knownProjects={props.knownProjects}
                                selected={activeKey() === skill.key}
                                selection={skill.selection}
                                title={skill.description || skill.name}
                              >
                                <span class={nodeLabel}>{skill.name}</span>
                                <Show when={skill.issueCount > 0 || skill.validationStatus === 'invalid'}>
                                  <span
                                    class={cx(statusPill, statusClass(skill.validationStatus), attentionPill)}
                                    title={skill.attentionSummary || undefined}
                                  >
                                    {skill.validationStatus === 'invalid' ? '!' : skill.issueCount}
                                  </span>
                                </Show>
                              </SkillSelectionLink>
                            )}
                          </For>
                        </div>
                      </Show>
                    </>
                  );
                })()}
              </section>
            )}
          </For>
          <Show when={emptyScopes().length > 0}>
            <details class={emptyFold}>
              <summary class={emptySummary}>Projects without skills ({emptyScopes().length})</summary>
              <For each={emptyScopes()}>
                {(scope) => (
                  <SkillSelectionLink
                    class={treeButton}
                    knownProjects={props.knownProjects}
                    selected={activeKey() === scope.key}
                    selection={scope.selection}
                    title={scope.path}
                  >
                    <span class={scopeLabel}>
                      <span class={strongCell}>{scope.label}</span>
                      <Show when={scope.shortPath}>{(shortPath) => <span class={scopePath}>{shortPath()}</span>}</Show>
                    </span>
                    <span class={subtleCount}>0</span>
                  </SkillSelectionLink>
                )}
              </For>
            </details>
          </Show>
        </Show>
      </div>
    </aside>
  );
};
