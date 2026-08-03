<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import type {
    ProjectSkillMarkdownDocument,
    ProjectSkillMarkdownInput,
    SkillMarkdownDocument,
  } from '@ai-usage/web-contract/skills';
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import type { RuntimeMode } from '../../../../runtime-mode';
  import {
    managedSkillMarkdownQueryOptions,
    projectSkillMarkdownQueryOptions,
    type SkillsQueryClient,
    skillsKnownProjectPathsQueryOptions,
    skillsProjectInventoriesQueryOptions,
    skillsSnapshotQueryOptions,
  } from '../../../query/options/skills';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import { createSkillsClient } from '../../../rpc/skills-client';
  import { createSkillsShellViewModel, type SkillsShellViewModel } from './model';
  import SkillsWorkspace, { type SkillsShellSlotContext } from './skills-workspace.svelte';

  let {
    editorSlot,
    healthSlot,
    matrixSlot,
    pathname,
    runtimeMode,
  }: {
    editorSlot?: Snippet<[SkillsShellSlotContext]>;
    healthSlot?: Snippet<[SkillsShellViewModel]>;
    matrixSlot?: Snippet<[SkillsShellSlotContext]>;
    pathname: string;
    runtimeMode: RuntimeMode;
  } = $props();

  let browserClient: ReturnType<typeof createSkillsClient> | undefined;
  const resolveClient = (): ReturnType<typeof createSkillsClient> => {
    browserClient ??= createSkillsClient(createBrowserWebRpcClient('skills-shell').skills);
    return browserClient;
  };
  const client: SkillsQueryClient = {
    getKnownSkillProjectPaths: (options) => resolveClient().getKnownSkillProjectPaths(options),
    getManagedSkillMarkdown: (skillName, options) => resolveClient().getManagedSkillMarkdown(skillName, options),
    getProjectSkillMarkdown: (input, options) => resolveClient().getProjectSkillMarkdown(input, options),
    getSkillManagementSnapshot: (options) => resolveClient().getSkillManagementSnapshot(options),
    getSkillProjectInventories: (options) => resolveClient().getSkillProjectInventories(options),
  };
  let mounted = $state(false);
  const queriesEnabled = $derived(mounted && runtimeMode !== 'demo');
  const snapshotQuery = createQuery(() =>
    skillsSnapshotQueryOptions(client, { browser: mounted, enabled: runtimeMode !== 'demo' }),
  );
  const knownPathsQuery = createQuery(() =>
    skillsKnownProjectPathsQueryOptions(client, { browser: mounted, enabled: runtimeMode !== 'demo' }),
  );
  const inventoriesQuery = createQuery(() =>
    skillsProjectInventoriesQueryOptions(client, {
      browser: mounted,
      enabled: runtimeMode !== 'demo' && snapshotQuery.data?.configured === true,
    }),
  );
  const view = $derived(
    snapshotQuery.data && knownPathsQuery.data
      ? createSkillsShellViewModel({
          inventories: inventoriesQuery.data ?? [],
          knownProjectPaths: knownPathsQuery.data,
          pathname,
          snapshot: snapshotQuery.data,
        })
      : undefined,
  );
  const managedSkillName = $derived(view?.selection.type === 'global-skill' ? view.selection.skillName : undefined);
  const managedDocumentQuery = createQuery(() =>
    managedSkillMarkdownQueryOptions(client, managedSkillName ?? '', {
      browser: mounted,
      enabled: queriesEnabled && managedSkillName !== undefined,
    }),
  );
  const projectDocumentInput = $derived.by<ProjectSkillMarkdownInput | undefined>(() => {
    if (view?.selectionDetail.kind !== 'project-skill') {
      return;
    }
    const observation = view.selectionDetail.skill.observations.at(0);
    if (observation === undefined) {
      return;
    }
    return {
      projectPath: observation.projectPath,
      runtimeDirId: observation.runtimeDirId,
      skillName: view.selectionDetail.skill.name,
    };
  });
  const projectDocumentQuery = createQuery(() =>
    projectSkillMarkdownQueryOptions(
      client,
      projectDocumentInput ?? { projectPath: '', runtimeDirId: 'agents-project', skillName: '' },
      {
        browser: mounted,
        enabled: queriesEnabled && projectDocumentInput !== undefined,
      },
    ),
  );
  const selectedDocument = $derived<ProjectSkillMarkdownDocument | SkillMarkdownDocument | undefined>(
    managedSkillName === undefined ? projectDocumentQuery.data : managedDocumentQuery.data,
  );
  const loading = $derived(snapshotQuery.isPending || knownPathsQuery.isPending);
  const messageFromError = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);
  const errorMessage = $derived(messageFromError(snapshotQuery.error) ?? messageFromError(knownPathsQuery.error));
  const statusPanel = css({
    display: 'grid',
    minH: '260px',
    placeItems: 'center',
    p: '20px',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    bg: 'surfaceMuted',
    color: 'muted',
  });

  onMount(() => {
    mounted = true;
  });

  $effect(() => {
    if (!(mounted && view?.fallbackHref)) {
      return;
    }
    goto(view.fallbackHref, { replaceState: true }).catch(() => undefined);
  });
</script>

{#if view && snapshotQuery.data}
  <SkillsWorkspace {editorSlot} {healthSlot} {matrixSlot} {selectedDocument} snapshot={view.snapshot} {view} />
{:else if loading}
  <div aria-busy="true" class={statusPanel}>Loading skills…</div>
{:else}
  <section aria-live="polite" class={statusPanel}>
    <div>
      <h2>Skills unavailable</h2>
      <p>{errorMessage ?? 'Skill data could not be loaded.'}</p>
    </div>
  </section>
{/if}
