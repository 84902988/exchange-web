import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockRead = jest.fn();
const mockWrite = jest.fn((_value: unknown) => Promise.resolve());

jest.mock('../src/components/chart/advancedChartPreferences', () => ({
  readAdvancedChartPreferences: () => mockRead(),
  writeAdvancedChartPreferences: (value: unknown) => mockWrite(value),
}));

import {
  DEFAULT_ADVANCED_CHART_PREFERENCES,
  configFromPreferences,
  type AdvancedChartPreferencesV2,
} from '../src/components/chart/advancedChartConfig';
import type { AdvancedChartPreferencesReadResult } from '../src/components/chart/advancedChartPreferences';
import { useAdvancedChartPreferences } from '../src/components/chart/useAdvancedChartPreferences';

let latestHook: ReturnType<typeof useAdvancedChartPreferences> | null = null;

function Harness({ tick }: { tick: number }) {
  latestHook = useAdvancedChartPreferences();
  return React.createElement('Harness', { tick });
}

function validRead(
  preferences: AdvancedChartPreferencesV2,
): AdvancedChartPreferencesReadResult {
  return { preferences, status: 'valid', writeProtected: false };
}

describe('useAdvancedChartPreferences', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    latestHook = null;
    mockRead.mockReset();
    mockWrite.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('keeps config and selection references stable on unrelated rerenders', async () => {
    mockRead.mockResolvedValue(validRead(DEFAULT_ADVANCED_CHART_PREFERENCES));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
      await Promise.resolve();
    });
    const config = latestHook!.config;
    const selection = latestHook!.selection;
    act(() => renderer.update(<Harness tick={2} />));
    expect(latestHook!.config).toBe(config);
    expect(latestHook!.selection).toBe(selection);
    act(() => renderer.unmount());
  });

  it('does not let a late hydration overwrite a user selection', async () => {
    let resolveRead!: (value: AdvancedChartPreferencesReadResult) => void;
    mockRead.mockReturnValue(
      new Promise<AdvancedChartPreferencesReadResult>(resolve => {
        resolveRead = resolve;
      }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
    });
    act(() => {
      latestHook!.selectIndicator('BOLL');
    });
    await act(async () => {
      resolveRead(
        validRead({
          ...DEFAULT_ADVANCED_CHART_PREFERENCES,
          selection: { overlay: 'EMA', pane: 'RSI' },
        }),
      );
      await Promise.resolve();
    });
    expect(latestHook!.selection).toEqual({ overlay: 'BOLL', pane: 'VOL' });
    expect(latestHook!.hydrated).toBe(true);
    act(() => renderer.unmount());
  });

  it('persists a complete settings edit and keeps it across late hydration', async () => {
    let resolveRead!: (value: AdvancedChartPreferencesReadResult) => void;
    mockRead.mockReturnValue(
      new Promise<AdvancedChartPreferencesReadResult>(resolve => {
        resolveRead = resolve;
      }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
    });
    const edited: AdvancedChartPreferencesV2 = {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: { overlay: 'SAR', pane: 'KDJ' },
      profiles: {
        ...DEFAULT_ADVANCED_CHART_PREFERENCES.profiles,
        SAR: { start: 0.03, increment: 0.02, maximum: 0.2 },
        KDJ: { length: 12, kSmoothing: 3, dSmoothing: 3 },
      },
    };

    act(() => latestHook!.commitPreferences(edited));
    expect(latestHook!.preferences).toEqual(edited);
    expect(mockWrite).toHaveBeenCalledWith(edited);

    await act(async () => {
      resolveRead(validRead(DEFAULT_ADVANCED_CHART_PREFERENCES));
      await Promise.resolve();
    });
    expect(latestHook!.preferences).toEqual(edited);
    act(() => renderer.unmount());
  });

  it('fails open after a bounded hydration timeout', () => {
    mockRead.mockReturnValue(new Promise(() => undefined));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
    });
    expect(latestHook!.hydrated).toBe(false);
    act(() => jest.advanceTimersByTime(800));
    expect(latestHook!.hydrated).toBe(true);
    act(() => renderer.unmount());
  });

  it('adopts a valid late read after timeout without overwriting it with the default receipt', async () => {
    let resolveRead!: (value: AdvancedChartPreferencesReadResult) => void;
    mockRead.mockReturnValue(
      new Promise<AdvancedChartPreferencesReadResult>(resolve => {
        resolveRead = resolve;
      }),
    );
    const stored: AdvancedChartPreferencesV2 = {
      ...DEFAULT_ADVANCED_CHART_PREFERENCES,
      selection: { overlay: 'EMA', pane: 'RSI' },
      profiles: {
        ...DEFAULT_ADVANCED_CHART_PREFERENCES.profiles,
        EMA: { length: 21 },
        RSI: { length: 10 },
      },
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(latestHook!.hydrated).toBe(true);

    act(() => latestHook!.commitConfig(latestHook!.config));
    expect(mockWrite).not.toHaveBeenCalled();
    // A no-op tap must not claim the hydration epoch.
    act(() => {
      latestHook!.selectIndicator('MA');
    });

    await act(async () => {
      resolveRead(validRead(stored));
      await Promise.resolve();
    });
    expect(latestHook!.preferences).toEqual(stored);
    expect(latestHook!.config).toEqual(configFromPreferences(stored));
    expect(mockWrite).not.toHaveBeenCalled();

    act(() => latestHook!.commitConfig(latestHook!.config));
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenLastCalledWith(stored);
    act(() => renderer.unmount());
  });

  it('protects a future schema until a real user edit explicitly migrates it', async () => {
    mockRead.mockResolvedValue({
      preferences: DEFAULT_ADVANCED_CHART_PREFERENCES,
      status: 'future_version',
      writeProtected: true,
    } satisfies AdvancedChartPreferencesReadResult);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
      await Promise.resolve();
    });

    act(() => latestHook!.commitConfig(latestHook!.config));
    act(() => {
      latestHook!.selectIndicator('MA');
    });
    act(() => latestHook!.commitConfig(latestHook!.config));
    expect(mockWrite).not.toHaveBeenCalled();

    act(() => {
      latestHook!.selectIndicator('BOLL');
    });
    act(() => latestHook!.commitConfig(latestHook!.config));
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        selection: { overlay: 'BOLL', pane: 'VOL' },
      }),
    );
    act(() => renderer.unmount());
  });

  it('persists the first confirmation without changing canonical references', async () => {
    mockRead.mockResolvedValue(validRead(DEFAULT_ADVANCED_CHART_PREFERENCES));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
      await Promise.resolve();
    });
    const config = latestHook!.config;
    const selection = latestHook!.selection;
    act(() => latestHook!.commitConfig(config));
    expect(latestHook!.config).toBe(config);
    expect(latestHook!.selection).toBe(selection);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('persists a native indicator selection immediately', async () => {
    mockRead.mockResolvedValue(validRead(DEFAULT_ADVANCED_CHART_PREFERENCES));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
      await Promise.resolve();
    });

    act(() => {
      latestHook!.selectNativeIndicator('BOLL');
    });
    expect(latestHook!.selection).toEqual({ overlay: 'BOLL', pane: 'VOL' });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { overlay: 'BOLL', pane: 'VOL' },
      }),
    );
    act(() => renderer.unmount());
  });

  it('commits an error actual config and rolls a later null error back to it', async () => {
    mockRead.mockResolvedValue(validRead(DEFAULT_ADVANCED_CHART_PREFERENCES));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Harness tick={1} />);
      await Promise.resolve();
    });
    const actual = {
      protocolVersion: 2 as const,
      overlay: { kind: 'EMA' as const, params: { length: 12 } },
      pane: { kind: 'RSI' as const, params: { length: 10 } },
    };
    act(() => latestHook!.handleConfigError(actual));
    expect(latestHook!.config).toEqual(actual);
    expect(mockWrite).toHaveBeenCalledTimes(1);

    act(() =>
      latestHook!.applyConfig({
        ...actual,
        overlay: { kind: 'EMA', params: { length: 30 } },
      }),
    );
    expect(latestHook!.config.overlay.params).toEqual({ length: 30 });
    act(() => latestHook!.handleConfigError(null));
    expect(latestHook!.config).toEqual(actual);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
