import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { RefreshButton } from '../src/components/assets/action/ActionPrimitives';

const mockFetchMyLoginLogs = jest.fn();
const mockTranslate = (key: string) => key;

jest.mock('../src/api', () => ({
  fetchMyLoginLogs: (...args: unknown[]) => mockFetchMyLoginLogs(...args),
}));

jest.mock('../src/i18n', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import LoginActivityScreen from '../src/screens/account/LoginActivityScreen';

describe('login activity request lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deduplicates refresh presses and aborts the active read on unmount', async () => {
    let resolveRequest!: (value: []) => void;
    mockFetchMyLoginLogs.mockImplementationOnce(
      () =>
        new Promise<[]>(resolve => {
          resolveRequest = resolve;
        }),
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LoginActivityScreen navigation={{ goBack: jest.fn() }} />,
      );
      await Promise.resolve();
    });

    const refresh = renderer.root.findByType(RefreshButton);
    act(() => {
      refresh.props.onPress();
      refresh.props.onPress();
    });
    expect(mockFetchMyLoginLogs).toHaveBeenCalledTimes(1);
    const signal = mockFetchMyLoginLogs.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => renderer.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveRequest([]);
      await Promise.resolve();
    });
  });
});
