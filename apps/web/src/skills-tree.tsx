import { css, cx } from '@ai-usage/design-system/css';
import {
  meta,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
  searchInput,
  statusPill,
  statusPillDanger,
  statusPillInfo,
  statusPillWarn,
  strongCell,
} from '@ai-usage/design-system/report';
import { createMemo, For, Show } from 'solid-js';
import { type SkillSelection, type SkillTreeModel, selectionKey } from './skills-page-model';

const treePanel = css({
  alignSelf: 'start',
  position: { base: 'static', xl: 'sticky' },
  top: '16px',
  maxH: { base: 'none', xl: 'calc(100vh - 32px)' },
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
  '&[aria-current="true"]': {
    bg: 'accentTint',
    borderColor: 'accent',
  },
});

const skillButton = css({
  pl: '20px',
});

const nodeLabel = css({
  overflowWrap: 'anywhere',
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

const filterInfo = css({
  color: 'muted',
  fontSize: '12px',
  lineHeight: 1.5,
});

const statusClass = (attentionCount: number, validationStatus?: string) => {
  if (validationStatus === 'invalid') {
    return statusPillDanger;
  }
  if (attentionCount > 0) {
    return statusPillWarn;
  }
  return statusPillInfo;
};

export const SkillsTree = (props: {
  model: SkillTreeModel;
  onQueryChange: (value: string) => void;
  onSelect: (selection: SkillSelection) => void;
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
        <Show fallback={<p class={filterInfo}>No scopes or skills match this filter.</p>} when={scopes().length > 0}>
          <For each={scopes()}>
            {(scope) => (
              <section class={scopeGroup}>
                <button
                  aria-current={activeKey() === scope.key ? 'true' : undefined}
                  class={treeButton}
                  onClick={() => props.onSelect(scope.selection)}
                  type="button"
                >
                  <span>
                    <span class={strongCell}>{scope.label}</span>
                    <Show when={scope.path}>{(path) => <span class={meta}> {path()}</span>}</Show>
                  </span>
                  <span class={subtleCount}>{scope.skills.length}</span>
                </button>
                <For each={scope.skills}>
                  {(skill) => (
                    <button
                      aria-current={activeKey() === skill.key ? 'true' : undefined}
                      class={cx(treeButton, skillButton)}
                      onClick={() => props.onSelect(skill.selection)}
                      type="button"
                    >
                      <span class={nodeLabel}>{skill.name}</span>
                      <Show when={skill.attentionCount > 0 || skill.validationStatus !== 'valid'}>
                        <span
                          class={cx(
                            statusPill,
                            statusClass(skill.attentionCount, skill.validationStatus),
                            attentionPill,
                          )}
                        >
                          {skill.validationStatus === 'invalid' ? '!' : skill.attentionCount}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
};
