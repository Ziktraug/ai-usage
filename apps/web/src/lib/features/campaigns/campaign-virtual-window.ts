export interface CampaignVirtualRow {
  key: string;
}

/** Navigation geometry only. The rows themselves stay in Query. */
export interface CampaignScrollAnchor {
  key: string;
  offset: number;
}

export interface CampaignScrollState {
  anchor?: CampaignScrollAnchor;
  focusKey?: string;
}

export const campaignOffsets = (
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
): number[] => {
  const offsets = [0];
  for (const key of keys) {
    offsets.push((offsets.at(-1) ?? 0) + (heights.get(key) ?? estimate));
  }
  return offsets;
};

export const campaignIndexAt = (offsets: readonly number[], top: number): number => {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) > top) {
      high = middle - 1;
    } else {
      low = middle;
    }
  }
  return low;
};

export const campaignVirtualWindow = (offsets: readonly number[], top: number, height: number) => ({
  start: Math.max(0, campaignIndexAt(offsets, top) - 4),
  end: Math.min(offsets.length - 1, campaignIndexAt(offsets, top + height) + 5),
});

export const campaignAnchorFor = (
  keys: readonly string[],
  offsets: readonly number[],
  top: number,
): CampaignScrollAnchor | undefined => {
  const index = campaignIndexAt(offsets, top);
  const key = keys[index];
  return key === undefined ? undefined : { key, offset: Math.max(0, top - (offsets[index] ?? 0)) };
};

/** A removed row falls back to its nearest surviving predecessor, then successor. */
export const campaignRestoreAnchor = (
  anchor: CampaignScrollAnchor,
  keys: readonly string[],
  offsets: readonly number[],
  previousKeys: readonly string[] = [],
): { anchor: CampaignScrollAnchor; top: number } | null => {
  let index = keys.indexOf(anchor.key);
  let offset = anchor.offset;
  if (index < 0) {
    const available = new Set(keys);
    const previousIndex = previousKeys.indexOf(anchor.key);
    let replacement: string | undefined;
    for (let cursor = previousIndex - 1; cursor >= 0; cursor -= 1) {
      if (available.has(previousKeys[cursor]!)) {
        replacement = previousKeys[cursor];
        break;
      }
    }
    if (replacement === undefined && previousIndex >= 0) {
      replacement = previousKeys.slice(previousIndex + 1).find((key) => available.has(key));
    }
    index = replacement === undefined ? -1 : keys.indexOf(replacement);
    offset = 0;
  }
  const key = keys[index];
  if (key === undefined) {
    return null;
  }
  const start = offsets[index] ?? 0;
  const height = (offsets[index + 1] ?? start) - start;
  const restored = { key, offset: Math.max(0, Math.min(offset, Math.max(0, height - 1))) };
  return { anchor: restored, top: start + restored.offset };
};

/** Shared by range and end callbacks; layout changes alone never renew this budget. */
export const createCampaignAcquisitionBudget = () => {
  let remaining = 2;
  return {
    advance: (): void => {
      remaining = 2;
    },
    run: (acquire: (() => boolean | undefined) | undefined): boolean => {
      if (!acquire || remaining === 0) {
        return false;
      }
      if (acquire() === false) {
        return false;
      }
      remaining -= 1;
      return true;
    },
  };
};
