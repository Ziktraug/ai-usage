import { describe, expect, test } from 'bun:test';
import { MAX_MACHINE_LABEL_BYTES } from '@ai-usage/web-contract/sync';
import {
  editingMachineLabel,
  MACHINE_LABEL_RENAME_FAILED,
  MACHINE_LABEL_TOO_LONG,
  MACHINE_LABEL_UNAVAILABLE,
  machineLabelByteLength,
  machineLabelDraftError,
  machineLabelIsSavable,
  machineLabelSaved,
  machineLabelSaveFailed,
  savingMachineLabel,
  viewingMachineLabel,
} from './machine-label-editor-model';

describe('machine label editor model', () => {
  test('moves view to editing to saving and back to view on success', () => {
    const view = viewingMachineLabel();
    expect(view.phase).toBe('view');
    expect(machineLabelIsSavable(view, 'Laptop', true)).toBe(false);

    const editing = editingMachineLabel('Laptop');
    expect(editing).toEqual({ draft: 'Laptop', error: null, phase: 'editing' });
    // The seeded draft is not yet a change, so Save stays closed until the label actually differs.
    expect(machineLabelIsSavable(editing, 'Laptop', true)).toBe(false);

    const changed = { ...editing, draft: '  Studio Mac  ' };
    expect(machineLabelIsSavable(changed, 'Laptop', true)).toBe(true);

    const saving = savingMachineLabel(changed);
    expect(saving.phase).toBe('saving');
    // A save in flight must not be re-submittable.
    expect(machineLabelIsSavable(saving, 'Laptop', true)).toBe(false);
    expect(machineLabelSaved().phase).toBe('view');
  });

  test('returns to editing with a stated reason when the rename fails', () => {
    const failed = machineLabelSaveFailed(
      savingMachineLabel({ ...editingMachineLabel('Laptop'), draft: 'Studio Mac' }),
    );
    expect(failed.phase).toBe('editing');
    expect(failed.error).toBe(MACHINE_LABEL_RENAME_FAILED);
    expect(machineLabelDraftError(failed, true)).toBe(MACHINE_LABEL_RENAME_FAILED);
    // The draft survives the failure so the rename can be retried without retyping.
    expect(failed.draft).toBe('Studio Mac');
    expect(machineLabelIsSavable(failed, 'Laptop', true)).toBe(true);
  });

  test('closes Save on a blank or over-byte draft rather than deferring to a late contract rejection', () => {
    const blank = { ...editingMachineLabel('Laptop'), draft: '   ' };
    expect(machineLabelIsSavable(blank, 'Laptop', true)).toBe(false);
    expect(machineLabelDraftError(blank, true)).toBeNull();

    const exact = { ...editingMachineLabel('Laptop'), draft: 'x'.repeat(MAX_MACHINE_LABEL_BYTES) };
    expect(machineLabelIsSavable(exact, 'Laptop', true)).toBe(true);
    expect(machineLabelDraftError(exact, true)).toBeNull();

    // Two-byte characters reach the engine's byte bound at half the character count, so a
    // character-counting `maxlength` would have let this through to a generic late failure.
    const multiByte = { ...editingMachineLabel('Laptop'), draft: 'é'.repeat(121) };
    expect(machineLabelByteLength(multiByte.draft)).toBe(242);
    expect(machineLabelIsSavable(multiByte, 'Laptop', true)).toBe(false);
    expect(machineLabelDraftError(multiByte, true)).toBe(MACHINE_LABEL_TOO_LONG);
    expect(machineLabelIsSavable({ ...multiByte, draft: 'é'.repeat(120) }, 'Laptop', true)).toBe(true);
  });

  test('closes an already-open editor when the engine becomes unreachable', () => {
    // The engine can disconnect after the editor is open; Save must not stay armed and then report a
    // generic rename failure when the real reason is that mutations are unavailable.
    const editing = { ...editingMachineLabel('Laptop'), draft: 'Studio Mac' };
    expect(machineLabelIsSavable(editing, 'Laptop', true)).toBe(true);
    expect(machineLabelIsSavable(editing, 'Laptop', false)).toBe(false);
    expect(machineLabelDraftError(editing, false)).toBe(MACHINE_LABEL_UNAVAILABLE);
    expect(machineLabelDraftError(viewingMachineLabel(), false)).toBeNull();
  });

  test('measures the trimmed draft, matching what the rename actually sends', () => {
    expect(machineLabelByteLength('  Studio Mac  ')).toBe(10);
    expect(machineLabelByteLength('é')).toBe(2);
  });
});
