<script lang="ts">
  import {
    type ProjectGroupConfig,
    type ProjectSourceSelector,
    projectLabelWithMachine,
    projectSourceSelectorFor,
    projectSourceSelectorsEqual,
  } from '@ai-usage/report-core/project-group';
  import type { UsageReportProjectSource } from '@ai-usage/report-core/report-data';
  import { untrack } from 'svelte';
  import { moveProjectSourcesToGroup } from '../../../../project-group-actions';
  import { button, field, item, list, muted, panel, panelHeader, row, stack, title } from '../breakdown/styles';

  let {
    createGroupId = () => globalThis.crypto.randomUUID(),
    disabled = false,
    initialGroups,
    onSave,
    sources,
  }: {
    createGroupId?: () => string;
    disabled?: boolean;
    initialGroups: readonly ProjectGroupConfig[];
    onSave: (groups: readonly ProjectGroupConfig[]) => Promise<void>;
    sources: readonly UsageReportProjectSource[];
  } = $props();

  let configs = $state<ProjectGroupConfig[]>(untrack(() => [...initialGroups]));
  let selectedIds = $state<string[]>([]);
  let draftName = $state('');
  let renames = $state<Record<string, string>>({});
  let saving = $state(false);
  let status = $state<string | null>(null);
  $effect(() => {
    configs = [...initialGroups];
  });

  const sortedSources = $derived(
    [...sources].sort((left, right) => sourceLabel(left).localeCompare(sourceLabel(right))),
  );
  const selectedSources = $derived(sortedSources.filter((source) => selectedIds.includes(source.id)));
  const sourceLabel = (source: UsageReportProjectSource): string =>
    projectLabelWithMachine(source.project, source.machineLabel);
  const selectorLabel = (selector: ProjectSourceSelector): string =>
    [selector.sourcePath, selector.project, selector.machineId].filter(Boolean).join(' · ');
  const matchingSource = (selector: ProjectSourceSelector): UsageReportProjectSource | undefined =>
    sortedSources.find((source) => projectSourceSelectorsEqual(selector, projectSourceSelectorFor(source)));
  const selectSource = (id: string, checked: boolean): void => {
    selectedIds = checked ? [...new Set([...selectedIds, id])] : selectedIds.filter((value) => value !== id);
  };
  const persist = async (next: readonly ProjectGroupConfig[], message: string): Promise<void> => {
    if (saving) {
      return;
    }
    saving = true;
    status = null;
    try {
      await onSave(next);
      configs = [...next];
      status = message;
    } catch (error) {
      status = error instanceof Error ? error.message : 'Project groups could not be saved.';
    } finally {
      saving = false;
    }
  };
  const createOrExtend = async (): Promise<void> => {
    const name = draftName.trim();
    if (!(name && selectedSources.length > 0)) {
      return;
    }
    const next = moveProjectSourcesToGroup({
      createGroupId: createGroupId(),
      groupName: name,
      projectGroups: configs,
      projectSources: [...sources],
      selectedSources,
    });
    await persist(next, `Saved ${name}`);
    draftName = '';
    selectedIds = [];
  };
  const rename = async (group: ProjectGroupConfig): Promise<void> => {
    const name = (renames[group.id] ?? group.name).trim();
    if (!name || name === group.name) {
      return;
    }
    await persist(
      configs.map((item) => (item.id === group.id ? { ...item, name } : item)),
      `Renamed ${group.name}`,
    );
  };
  const deleteGroup = async (group: ProjectGroupConfig): Promise<void> =>
    await persist(
      configs.filter((item) => item.id !== group.id),
      `Deleted ${group.name}`,
    );
  const removeSelector = async (group: ProjectGroupConfig, selector: ProjectSourceSelector): Promise<void> => {
    const remaining = group.sources.filter((candidate) => !projectSourceSelectorsEqual(candidate, selector));
    await persist(
      remaining.length > 0
        ? configs.map((item) => (item.id === group.id ? { ...item, sources: remaining } : item))
        : configs.filter((item) => item.id !== group.id),
      `Updated ${group.name}`,
    );
  };
</script>

<section class={panel} data-project-group-editor>
  <header class={panelHeader}>
    <div>
      <h2 class={title}>Project groups</h2>
      <p class={muted}>Persisted locally without changing report identity.</p>
    </div>
  </header>
  <div class={stack}>
    <h3>Sources</h3>
    {#if sortedSources.length === 0}
      <p class={muted}>No project sources</p>
    {/if}
    <div class={list}>
      {#each sortedSources as source (source.id)}
        <label class={item}>
          <span
            ><input
              checked={selectedIds.includes(source.id)}
              disabled={disabled || saving}
              onchange={(event) => selectSource(source.id, event.currentTarget.checked)}
              type="checkbox"
            > {sourceLabel(source)}</span
          >
          <span class={muted}>{source.sourcePath} · {source.sessions} sessions</span>
        </label>
      {/each}
    </div>
    <div class={row}>
      <input
        aria-label="Project group name"
        class={field}
        disabled={disabled || saving}
        placeholder="Group name"
        bind:value={draftName}
      >
      <button
        class={button}
        disabled={disabled || saving || !draftName.trim() || selectedSources.length === 0}
        onclick={createOrExtend}
        type="button"
      >
        Group selected
      </button>
    </div>
    <h3>Persisted groups</h3>
    {#if configs.length === 0}
      <p class={muted}>No persisted project groups</p>
    {/if}
    <div class={list}>
      {#each configs as group (group.id)}
        <article class={panel}>
          <div class={row}>
            <input
              aria-label={`Name for ${group.name}`}
              class={field}
              disabled={disabled || saving}
              oninput={(event) => (renames = { ...renames, [group.id]: event.currentTarget.value })}
              value={renames[group.id] ?? group.name}
            >
            <button
              class={button}
              disabled={disabled || saving || (renames[group.id] ?? group.name).trim() === group.name}
              onclick={() => rename(group)}
              type="button"
            >
              Rename
            </button>
            <button class={button} disabled={disabled || saving} onclick={() => deleteGroup(group)} type="button">
              Delete
            </button>
          </div>
          {#each group.sources as selector (selectorLabel(selector))}
            {@const source = matchingSource(selector)}
            <div class={item}>
              <span
                >{source ? sourceLabel(source) : 'Missing source'}
                <span class={muted}> · {source ? source.sourcePath : selectorLabel(selector)}</span></span
              >
              <button
                class={button}
                disabled={disabled || saving}
                onclick={() => removeSelector(group, selector)}
                type="button"
              >
                Remove
              </button>
            </div>
          {/each}
        </article>
      {/each}
    </div>
    <div aria-live="polite" class={muted}>
      {status ?? (disabled ? 'Editing is available from the live web dashboard.' : '')}
    </div>
  </div>
</section>
