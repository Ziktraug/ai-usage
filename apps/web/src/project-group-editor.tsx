import { css, cx } from '@ai-usage/design-system/css';
import {
  commandButton,
  empty,
  field,
  ghostButton,
  panel,
  panelHeader,
  panelSub,
  panelTitle,
} from '@ai-usage/design-system/report';
import {
  type ProjectGroupConfig,
  type ProjectSourceSelector,
  projectSourceSelectorFor,
  projectSourceSelectorsEqual,
} from '@ai-usage/report-core/project-group';
import type { UsageReportProjectSource } from '@ai-usage/report-core/report-data';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { moveProjectSourcesToGroup } from './project-group-actions';
import type { WebReportPayloadWithoutRows } from './web-report-payload';

const editorPanel = css({
  mb: '14px',
});

const editorGrid = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(420px, 1.1fr) minmax(360px, 0.9fr)' },
  gap: '16px',
  alignItems: 'start',
});

const editorSection = css({
  display: 'grid',
  gap: '10px',
  minW: 0,
});

const sectionTitle = css({
  fontSize: '12px',
  fontWeight: 700,
  color: 'muted',
  textTransform: 'uppercase',
  letterSpacing: '0',
});

const sourceList = css({
  display: 'grid',
  maxH: '320px',
  overflow: 'auto',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
});

const sourceRow = css({
  display: 'grid',
  gridTemplateColumns: '22px minmax(0, 1fr)',
  gap: '10px',
  alignItems: 'start',
  p: '10px 12px',
  borderBottom: '1px solid token(colors.line)',
  cursor: 'pointer',
  _last: {
    borderBottom: '0',
  },
});

const sourceCheckbox = css({
  mt: '2px',
});

const sourceName = css({
  display: 'block',
  fontSize: '13px',
  fontWeight: 650,
  color: 'ink',
  overflowWrap: 'anywhere',
  lineHeight: 1.35,
});

const sourceMeta = css({
  display: 'block',
  mt: '2px',
  color: 'muted',
  fontSize: '12px',
  overflowWrap: 'anywhere',
  lineHeight: 1.35,
});

const formRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'minmax(180px, 1fr) auto' },
  gap: '8px',
  alignItems: 'center',
});

const groupList = css({
  display: 'grid',
  gap: '10px',
});

const groupCard = css({
  display: 'grid',
  gap: '10px',
  p: '12px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surfaceMuted',
});

const groupHeaderRow = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', md: 'minmax(0, 1fr) auto' },
  gap: '8px',
  alignItems: 'center',
});

const groupActions = css({
  display: 'flex',
  gap: '8px',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
});

const compactButton = cx(
  ghostButton,
  css({
    minW: '72px',
    whiteSpace: 'nowrap',
  }),
);

const groupSources = css({
  display: 'grid',
  gap: '6px',
});

const groupSourceRow = css({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '8px',
  alignItems: 'center',
  p: '8px 10px',
  border: '1px solid token(colors.line)',
  borderRadius: 'sm',
  bg: 'surface',
});

const groupSourceText = css({
  minW: 0,
});

const staleSource = css({
  color: 'muted',
  fontStyle: 'italic',
});

const statusText = css({
  color: 'muted',
  fontSize: '12px',
  minH: '18px',
});

const projectSourceLabel = (source: UsageReportProjectSource) =>
  source.machineLabel ? `${source.project} · ${source.machineLabel}` : source.project;

const projectSourceMeta = (source: UsageReportProjectSource) =>
  [source.sourcePath, `${source.sessions} sessions`].filter(Boolean).join(' · ');

const selectorLabel = (selector: ProjectSourceSelector) =>
  [selector.sourcePath, selector.project, selector.machineId].filter(Boolean).join(' · ');

export const ProjectGroupEditor = (props: {
  disabled?: boolean;
  onSave: (projectGroups: ProjectGroupConfig[]) => Promise<void>;
  payload: Pick<WebReportPayloadWithoutRows, 'projectGroupConfigs' | 'projectGroups'>;
}) => {
  const [selectedSourceIds, setSelectedSourceIds] = createSignal<string[]>([]);
  const [draftName, setDraftName] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [renames, setRenames] = createSignal<Record<string, string>>({});

  const sources = createMemo(() => {
    const byId = new Map<string, UsageReportProjectSource>();
    for (const group of props.payload.projectGroups ?? []) {
      for (const source of group.sources) {
        byId.set(source.id, source);
      }
    }
    return [...byId.values()].sort((left, right) => projectSourceLabel(left).localeCompare(projectSourceLabel(right)));
  });

  const configs = () => props.payload.projectGroupConfigs ?? [];

  const selectedSources = createMemo(() => {
    const ids = new Set(selectedSourceIds());
    return sources().filter((source) => ids.has(source.id));
  });

  const sourcesForGroup = (group: ProjectGroupConfig) =>
    group.sources.map((selector) => ({
      selector,
      source: sources().find((source) => projectSourceSelectorsEqual(selector, projectSourceSelectorFor(source))),
    }));

  const updateSelected = (sourceId: string, checked: boolean) => {
    setSelectedSourceIds((current) => {
      if (checked) {
        return current.includes(sourceId) ? current : [...current, sourceId];
      }
      return current.filter((id) => id !== sourceId);
    });
  };

  const saveGroups = async (groups: ProjectGroupConfig[], successMessage: string) => {
    setSaving(true);
    setStatus(null);
    try {
      await props.onSave(groups);
      setStatus(successMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const createOrExtendGroup = async () => {
    const name = draftName().trim();
    const selected = selectedSources();
    if (!(name && selected.length) || saving()) {
      return;
    }
    const nextGroups = moveProjectSourcesToGroup({
      createGroupId: globalThis.crypto?.randomUUID?.() ?? `project-group-${Date.now()}`,
      groupName: name,
      projectGroups: configs(),
      projectSources: sources(),
      selectedSources: selected,
    });
    await saveGroups(nextGroups, `Saved ${name}`);
    setDraftName('');
    setSelectedSourceIds([]);
  };

  const renameGroup = async (group: ProjectGroupConfig) => {
    const name = (renames()[group.id] ?? group.name).trim();
    if (!name || name === group.name || saving()) {
      return;
    }
    await saveGroups(
      configs().map((item) => (item.id === group.id ? { ...item, name } : item)),
      `Renamed ${group.name}`,
    );
  };

  const deleteGroup = (group: ProjectGroupConfig) =>
    saveGroups(
      configs().filter((item) => item.id !== group.id),
      `Deleted ${group.name}`,
    );

  const removeSelectorFromGroup = (group: ProjectGroupConfig, selector: ProjectSourceSelector) => {
    const nextSources = group.sources.filter((candidate) => !projectSourceSelectorsEqual(candidate, selector));
    if (!nextSources.length) {
      return deleteGroup(group);
    }
    return saveGroups(
      configs().map((item) => (item.id === group.id ? { ...item, sources: nextSources } : item)),
      `Updated ${group.name}`,
    );
  };

  return (
    <section class={cx(panel, editorPanel)}>
      <div class={panelHeader}>
        <h2 class={panelTitle}>Project groups</h2>
        <p class={panelSub}>Persisted locally. Reports receive grouped projects as native project names.</p>
      </div>
      <div class={editorGrid}>
        <div class={editorSection}>
          <div class={sectionTitle}>Sources</div>
          <Show fallback={<div class={empty}>No project sources</div>} when={sources().length}>
            <div class={sourceList}>
              <For each={sources()}>
                {(source) => (
                  <label class={sourceRow}>
                    <input
                      checked={selectedSourceIds().includes(source.id)}
                      class={sourceCheckbox}
                      disabled={props.disabled || saving()}
                      onChange={(event) => updateSelected(source.id, event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span>
                      <span class={sourceName}>{projectSourceLabel(source)}</span>
                      <span class={sourceMeta}>{projectSourceMeta(source)}</span>
                    </span>
                  </label>
                )}
              </For>
            </div>
          </Show>
          <div class={formRow}>
            <input
              class={field}
              disabled={props.disabled || saving()}
              onInput={(event) => setDraftName(event.currentTarget.value)}
              placeholder="Group name"
              value={draftName()}
            />
            <button
              class={commandButton}
              disabled={props.disabled || saving() || !draftName().trim() || selectedSources().length === 0}
              onClick={createOrExtendGroup}
              type="button"
            >
              Group selected
            </button>
          </div>
        </div>
        <div class={editorSection}>
          <div class={sectionTitle}>Persisted groups</div>
          <Show fallback={<div class={empty}>No persisted project groups</div>} when={configs().length}>
            <div class={groupList}>
              <For each={configs()}>
                {(group) => (
                  <div class={groupCard}>
                    <div class={groupHeaderRow}>
                      <input
                        class={field}
                        disabled={props.disabled || saving()}
                        onInput={(event) =>
                          setRenames((current) => ({ ...current, [group.id]: event.currentTarget.value }))
                        }
                        value={renames()[group.id] ?? group.name}
                      />
                      <div class={groupActions}>
                        <button
                          class={compactButton}
                          disabled={
                            props.disabled || saving() || (renames()[group.id] ?? group.name).trim() === group.name
                          }
                          onClick={() => renameGroup(group)}
                          type="button"
                        >
                          Rename
                        </button>
                        <button
                          class={compactButton}
                          disabled={props.disabled || saving()}
                          onClick={() => deleteGroup(group)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div class={groupSources}>
                      <For each={sourcesForGroup(group)}>
                        {(item) => (
                          <div class={groupSourceRow}>
                            <div class={groupSourceText}>
                              <Show
                                fallback={
                                  <>
                                    <span class={cx(sourceName, staleSource)}>Missing source</span>
                                    <span class={sourceMeta}>{selectorLabel(item.selector)}</span>
                                  </>
                                }
                                when={item.source}
                              >
                                {(source) => (
                                  <>
                                    <span class={sourceName}>{projectSourceLabel(source())}</span>
                                    <span class={sourceMeta}>{projectSourceMeta(source())}</span>
                                  </>
                                )}
                              </Show>
                            </div>
                            <button
                              class={compactButton}
                              disabled={props.disabled || saving()}
                              onClick={() => {
                                removeSelectorFromGroup(group, item.selector)?.catch((error: unknown) => {
                                  console.error(error);
                                });
                              }}
                              title={`Remove ${
                                item.source ? projectSourceLabel(item.source) : selectorLabel(item.selector)
                              }`}
                              type="button"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div aria-live="polite" class={statusText}>
            {status() ?? (props.disabled ? 'Editing is available from the live web dashboard.' : '')}
          </div>
        </div>
      </div>
    </section>
  );
};
