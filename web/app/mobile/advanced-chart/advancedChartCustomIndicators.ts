import type {
  CustomIndicator,
  IPineStudyResult,
  LibraryPineStudy,
  StudyInputValue,
} from '../../../public/tradingview/charting_library/charting_library';
import type { TradingViewCustomIndicatorsGetter } from '@/components/tradingview/customIndicators';

export const getAdvancedChartCustomIndicators: TradingViewCustomIndicatorsGetter = (
  pineJs,
) => Promise.resolve([
  {
    name: 'KDJ',
    metainfo: {
      _metainfoVersion: 53,
      id: 'KDJ@exchange-mobile-1',
      description: 'KDJ',
      shortDescription: 'KDJ',
      isCustomIndicator: true,
      is_price_study: false,
      linkedToSeries: false,
      format: {type: 'price', precision: 2},
      plots: [
        {id: 'k', type: 'line'},
        {id: 'd', type: 'line'},
        {id: 'j', type: 'line'},
      ],
      styles: {
        k: {title: 'K'},
        d: {title: 'D'},
        j: {title: 'J'},
      },
      defaults: {
        styles: {
          k: {
            color: '#f0b90b',
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
          },
          d: {
            color: '#e84a8a',
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
          },
          j: {
            color: '#8b6df6',
            linestyle: 0,
            linewidth: 2,
            plottype: 0,
            trackPrice: false,
            transparency: 0,
            visible: true,
          },
        },
        inputs: {
          length: 9,
          kSmoothing: 3,
          dSmoothing: 3,
        },
      },
      inputs: [
        {
          id: 'length',
          name: 'Length',
          defval: 9,
          type: 'integer',
          min: 1,
          max: 500,
        },
        {
          id: 'kSmoothing',
          name: 'K smoothing',
          defval: 3,
          type: 'integer',
          min: 1,
          max: 100,
        },
        {
          id: 'dSmoothing',
          name: 'D smoothing',
          defval: 3,
          type: 'integer',
          min: 1,
          max: 100,
        },
      ],
    } as unknown as CustomIndicator['metainfo'],
    constructor: function (this: LibraryPineStudy<IPineStudyResult>) {
      this.main = function (context, inputs) {
        this._context = context;
        this._input = inputs;
        const length = Number(inputs<StudyInputValue>(0));
        const kSmoothing = Number(inputs<StudyInputValue>(1));
        const dSmoothing = Number(inputs<StudyInputValue>(2));
        context.setMinimumAdditionalDepth(length + kSmoothing + dSmoothing);

        const highSeries = context.new_var(pineJs.Std.high(context));
        const lowSeries = context.new_var(pineJs.Std.low(context));
        const highest = pineJs.Std.highest(highSeries, length, context);
        const lowest = pineJs.Std.lowest(lowSeries, length, context);
        const range = highest - lowest;
        const close = pineJs.Std.close(context);
        const rsv = Number.isFinite(range) && range > 0
          ? ((close - lowest) / range) * 100
          : 50;
        const k = pineJs.Std.smma(rsv, kSmoothing, context);
        const d = pineJs.Std.smma(k, dSmoothing, context);
        const j = (3 * k) - (2 * d);
        return [k, d, j];
      };
    },
  },
]);
