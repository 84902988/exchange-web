import type { CustomIndicator } from '../../../public/tradingview/charting_library/charting_library';

import { getAdvancedChartCustomIndicators } from './advancedChartCustomIndicators';

describe('mobile advanced chart custom indicators', () => {
  test('registers a three-line KDJ study with 9/3/3 defaults', async () => {
    const pineJs = {
      Std: {
        high: jest.fn(() => 110),
        low: jest.fn(() => 90),
        close: jest.fn(() => 105),
        highest: jest.fn(() => 110),
        lowest: jest.fn(() => 90),
        smma: jest.fn((value: number) => value),
      },
    };
    const [indicator] = await getAdvancedChartCustomIndicators(
      pineJs as Parameters<typeof getAdvancedChartCustomIndicators>[0],
    );

    expect(indicator.name).toBe('KDJ');
    expect(indicator.metainfo.description).toBe('KDJ');
    expect(indicator.metainfo.plots).toEqual([
      {id: 'k', type: 'line'},
      {id: 'd', type: 'line'},
      {id: 'j', type: 'line'},
    ]);
    expect(indicator.metainfo.defaults.inputs).toEqual({
      length: 9,
      kSmoothing: 3,
      dSmoothing: 3,
    });

    const study = {} as Record<string, unknown>;
    (indicator.constructor as unknown as (this: Record<string, unknown>) => void)
      .call(study);
    const context = {
      setMinimumAdditionalDepth: jest.fn(),
      new_var: jest.fn((value: number) => ({value})),
    };
    const result = (study.main as (
      contextValue: typeof context,
      input: (index: number) => number,
    ) => number[])(context, index => [9, 3, 3][index]);

    expect(context.setMinimumAdditionalDepth).toHaveBeenCalledWith(15);
    expect(pineJs.Std.smma).toHaveBeenNthCalledWith(1, 75, 3, context);
    expect(pineJs.Std.smma).toHaveBeenNthCalledWith(2, 75, 3, context);
    expect(result).toEqual([75, 75, 75]);
  });

  test('returns a neutral KDJ value when the candle range is zero', async () => {
    const smma = jest.fn((value: number) => value);
    const pineJs = {
      Std: {
        high: () => 100,
        low: () => 100,
        close: () => 100,
        highest: () => 100,
        lowest: () => 100,
        smma,
      },
    };
    const [indicator] = await getAdvancedChartCustomIndicators(
      pineJs as Parameters<typeof getAdvancedChartCustomIndicators>[0],
    );
    const study = {} as Record<string, unknown>;
    (indicator as CustomIndicator).constructor.call(study);
    const context = {
      setMinimumAdditionalDepth: jest.fn(),
      new_var: (value: number) => ({value}),
    };
    const result = (study.main as (
      contextValue: typeof context,
      input: (index: number) => number,
    ) => number[])(context, index => [9, 3, 3][index]);

    expect(smma).toHaveBeenNthCalledWith(1, 50, 3, context);
    expect(result).toEqual([50, 50, 50]);
  });
});
