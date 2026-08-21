import { MAX_MACHINE_LABEL_BYTES } from '@ai-usage/web-contract/sync';

// The engine bounds a machine label by UTF-8 bytes, so the editor measures bytes too. `maxlength`
// counts UTF-16 code units, which would let 121 two-byte characters through to a late, generic
// rejection at the contract boundary.
const encoder = new TextEncoder();

export type MachineLabelEditorPhase = 'editing' | 'saving' | 'view';

export interface MachineLabelEditorState {
  readonly draft: string;
  readonly error: string | null;
  readonly phase: MachineLabelEditorPhase;
}

export const MACHINE_LABEL_TOO_LONG = `A machine label must not exceed ${MAX_MACHINE_LABEL_BYTES} bytes.`;
export const MACHINE_LABEL_RENAME_FAILED = 'The machine could not be renamed.';
export const MACHINE_LABEL_UNAVAILABLE = 'Renaming is unavailable while the usage engine is unreachable.';

export const machineLabelByteLength = (value: string): number => encoder.encode(value.trim()).byteLength;

export const machineLabelIsWithinBound = (value: string): boolean =>
  machineLabelByteLength(value) <= MAX_MACHINE_LABEL_BYTES;

export const viewingMachineLabel = (): MachineLabelEditorState => ({ draft: '', error: null, phase: 'view' });

export const editingMachineLabel = (label: string): MachineLabelEditorState => ({
  draft: label,
  error: null,
  phase: 'editing',
});

/**
 * A draft is submittable only when it is a real change the engine will also accept, and only while
 * the engine is reachable: availability can drop while the editor is already open.
 */
export const machineLabelIsSavable = (state: MachineLabelEditorState, label: string, editable: boolean): boolean => {
  const draft = state.draft.trim();
  return (
    editable &&
    state.phase === 'editing' &&
    draft.length > 0 &&
    draft !== label &&
    machineLabelIsWithinBound(state.draft)
  );
};

export const machineLabelDraftError = (state: MachineLabelEditorState, editable: boolean): string | null => {
  if (state.phase === 'view') {
    return state.error;
  }
  if (!editable) {
    return MACHINE_LABEL_UNAVAILABLE;
  }
  if (!machineLabelIsWithinBound(state.draft)) {
    return MACHINE_LABEL_TOO_LONG;
  }
  return state.error;
};

export const savingMachineLabel = (state: MachineLabelEditorState): MachineLabelEditorState => ({
  ...state,
  error: null,
  phase: 'saving',
});

export const machineLabelSaveFailed = (state: MachineLabelEditorState): MachineLabelEditorState => ({
  ...state,
  error: MACHINE_LABEL_RENAME_FAILED,
  phase: 'editing',
});

export const machineLabelSaved = (): MachineLabelEditorState => viewingMachineLabel();
