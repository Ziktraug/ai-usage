import { statusPillDanger, statusPillInfo, statusPillOk, statusPillWarn } from '@ai-usage/design-system/report';
import type { SourcePresentationTone } from './source-control-presentation-model';

export {
  presentSourceProgress,
  presentSourceState,
  type SourcePresentation,
  type SourcePresentationTone,
  type SourceProgressPresentation,
} from './source-control-presentation-model';

export const sourceToneClass = (tone: SourcePresentationTone): string => {
  if (tone === 'ok') {
    return statusPillOk;
  }
  if (tone === 'danger') {
    return statusPillDanger;
  }
  return tone === 'warning' ? statusPillWarn : statusPillInfo;
};
