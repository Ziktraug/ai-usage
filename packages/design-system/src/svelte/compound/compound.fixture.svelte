<script lang="ts">
  import SegmentedControl from './segmented-control.svelte';
  import Tabs from './tabs.svelte';

  let selectedRange = $state('week');
  let selectedTab = $state('overview');
</script>

{#snippet overviewPanel()}
  <p>Overview fixture panel</p>
{/snippet}

{#snippet sessionsPanel()}
  <button type="button">Focusable session fixture</button>
{/snippet}

{#snippet unavailablePanel()}
  <p>Disabled fixture panel</p>
{/snippet}

<section aria-label="Compound controls fixture">
  <div data-testid="segmented-control-fixture" data-value={selectedRange}>
    <SegmentedControl
      ariaLabel="Fixture range"
      defaultValue="week"
      items={[
        { label: 'Day', value: 'day' },
        { label: 'Week', value: 'week' },
        { label: 'Month', value: 'month' },
      ]}
      label="Range"
      onValueChange={(value) => (selectedRange = value)}
      value={selectedRange}
    />
  </div>

  <div data-testid="tabs-fixture" data-value={selectedTab}>
    <Tabs
      ariaLabel="Fixture sections"
      items={[
        { content: overviewPanel, label: 'Overview', value: 'overview' },
        { content: sessionsPanel, label: 'Sessions', value: 'sessions' },
        { content: unavailablePanel, disabled: true, label: 'Unavailable', value: 'unavailable' },
      ]}
      onValueChange={(value) => (selectedTab = value)}
      value={selectedTab}
    />
  </div>
</section>
