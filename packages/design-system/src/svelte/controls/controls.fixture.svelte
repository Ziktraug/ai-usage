<script lang="ts">
  import Checkbox from './checkbox.svelte';
  import HarnessBadge from './harness-badge.svelte';
  import MetricTile from './metric-tile.svelte';
  import SegmentBar from './segment-bar.svelte';
  import Toggle from './toggle.svelte';

  let badgeActive = $state(false);
  let badgeChanges = $state(0);
  let badgeParentClicks = $state(0);
  let checked = $state(true);
  let checkboxChanges = $state(0);
  let disabledCheckboxChanges = $state(0);
  let pressed = $state(false);
  let toggleChanges = $state(0);
  let toggleOrder = $state('');

  const badgeParentEvents = {
    onclick: (): void => {
      badgeParentClicks += 1;
    },
  };
  const retainDisabledState = (_pressed: boolean): void => undefined;
</script>

<section aria-label="Basic controls fixture">
  <div data-changes={toggleChanges} data-order={toggleOrder} data-pressed={pressed} data-testid="toggle-fixture">
    <Toggle
      ariaLabel="Toggle synthetic feature"
      onClick={() => (toggleOrder += 'click,')}
      onPressedChange={(nextPressed) => {
        toggleOrder += 'pressed,';
        toggleChanges += 1;
        pressed = nextPressed;
      }}
      {pressed}
      title="Toggle synthetic feature"
    >
      Synthetic toggle
    </Toggle>
    <button onclick={() => (pressed = false)} type="button">Reset synthetic toggle</button>
    <Toggle ariaLabel="Disabled synthetic feature" disabled onPressedChange={retainDisabledState} pressed={false}>
      Disabled toggle
    </Toggle>
  </div>

  <div data-testid="badge-fixture" {...badgeParentEvents}>
    <HarnessBadge
      active={badgeActive}
      name="Claude Code"
      onClick={() => {
        badgeActive = !badgeActive;
        badgeChanges += 1;
      }}
    />
    <HarnessBadge name="Unknown Agent" />
    <output data-changes={badgeChanges} data-parent-clicks={badgeParentClicks} data-testid="badge-state">
      {badgeActive ? 'active' : 'inactive'}
    </output>
  </div>

  <div
    data-changes={checkboxChanges}
    data-checked={checked}
    data-disabled-changes={disabledCheckboxChanges}
    data-testid="checkbox-fixture"
  >
    <Checkbox
      {checked}
      onCheckedChange={(nextChecked) => {
        checked = nextChecked;
        checkboxChanges += 1;
      }}
    >
      Synthetic checkbox
    </Checkbox>
    <Checkbox checked={false} disabled onCheckedChange={() => (disabledCheckboxChanges += 1)}>
      Disabled synthetic checkbox
    </Checkbox>
  </div>

  <div data-testid="segment-fixture">
    <SegmentBar
      ariaLabel="Synthetic proportions"
      segments={[
        { class: 'segment-a', label: 'Alpha', value: 1 },
        { class: 'segment-hidden', label: 'Hidden', value: 0 },
        { class: 'segment-b', label: 'Beta', title: 'Custom beta title', value: 3 },
      ]}
    />
    <SegmentBar ariaLabel="Empty proportions" segments={[]} />
  </div>

  <div data-testid="metric-fixture">
    <MetricTile
      delta={{ hint: 'Compared with synthetic baseline', label: 'Down 2%', positive: false }}
      hint="Synthetic metric hint"
      label="Synthetic metric"
      value="42"
    />
  </div>
</section>
