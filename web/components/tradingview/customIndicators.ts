import type {
  CustomIndicator,
  PineJS,
} from '../../public/tradingview/charting_library/charting_library';

export type TradingViewCustomIndicatorsGetter = (
  pineJs: PineJS,
) => Promise<readonly CustomIndicator[]>;
