import type { SourcePresentationTone } from '../../../source-control-presentation-model';
import { statusPillDanger, statusPillInfo, statusPillOk, statusPillWarn } from './styles';

export {
  presentSourceProgress,
  presentSourceState,
  type SourcePresentation,
  type SourcePresentationTone,
  type SourceProgressPresentation,
} from '../../../source-control-presentation-model';

export const sourceToneClass = (tone: SourcePresentationTone): string => {
  if (tone === 'ok') {
    return statusPillOk;
  }
  if (tone === 'danger') {
    return statusPillDanger;
  }
  return tone === 'warning' ? statusPillWarn : statusPillInfo;
};
