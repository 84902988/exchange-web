import React from 'react';
import { Text } from 'react-native';
import Renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LanguageProvider, MOBILE_LOCALE_STORAGE_KEY } from '../src/i18n';
import * as assets from '../src/api/assets';
import { apiClient } from '../src/api/client';
import DepositProgress from '../src/components/assets/action/DepositProgress';
import { depositStage } from '../src/utils/depositStatus';

let mockActive = true;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) =>
    require('react').useEffect(callback, [callback]),
}));
jest.mock('../src/hooks/useApplicationState', () => ({
  useApplicationActive: () => mockActive,
}));
const address: assets.DepositAddress = {
  symbol: 'USDT',
  network: 'bsc',
  address: '0xAbCd',
  depositEnabled: true,
  minDeposit: '0',
  notice: [],
};
const row: assets.DepositRecord = {
  id: 7,
  symbol: 'USDT',
  network: 'bsc',
  address: '0xAbCd',
  amount: '5',
  status: 'DETECTING',
  txid: '0xtx',
  confirmations: 0,
  confirmRequired: 15,
  createdAt: '',
  credited: false,
  creditDestination: null,
};
let renderer: Renderer.ReactTestRenderer;
function element(a = address) {
  return (
    <LanguageProvider>
      <DepositProgress key={a.address + a.network} address={a} />
    </LanguageProvider>
  );
}
async function render() {
  await act(async () => {
    renderer = Renderer.create(element());
  });
}
function text() {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .join(' ');
}

beforeEach(async () => {
  jest.useFakeTimers();
  mockActive = true;
  await AsyncStorage.clear();
  await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  jest
    .spyOn(assets, 'fetchDepositRecords')
    .mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('automatically tracks detected, confirmed and actually credited states', async () => {
  await render();
  expect(text()).toContain('No deposit record');
  jest
    .mocked(assets.fetchDepositRecords)
    .mockResolvedValue({ items: [row], total: 1 });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(text()).toContain('0 / 15');
  expect(depositStage(row)).toBe('detected');
  const confirmed = { ...row, status: 'CONFIRMED', confirmations: 15 };
  expect(depositStage(confirmed)).toBe('confirmed');
  jest
    .mocked(assets.fetchDepositRecords)
    .mockResolvedValue({ items: [confirmed], total: 1 });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(text()).toContain('15 / 15');
  const credited = {
    ...confirmed,
    credited: true,
    creditDestination: 'funding',
  };
  expect(depositStage(credited)).toBe('credited');
  jest
    .mocked(assets.fetchDepositRecords)
    .mockResolvedValue({ items: [credited], total: 1 });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(assets.fetchDepositRecords).toHaveBeenCalledTimes(4);
});

it('shows stale status on network failure and recovers without assuming success', async () => {
  jest
    .mocked(assets.fetchDepositRecords)
    .mockRejectedValue(new Error('timeout'));
  await render();
  expect(text()).toContain('Unable to update status');
  jest
    .mocked(assets.fetchDepositRecords)
    .mockResolvedValue({ items: [row], total: 1 });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(text()).not.toContain('Unable to update status');
  expect(text()).toContain('Monitoring deposit records');
});

it('pauses in background, resumes on return, and never overlaps slow requests', async () => {
  let resolve!: (value: {
    items: assets.DepositRecord[];
    total: number;
  }) => void;
  jest.mocked(assets.fetchDepositRecords).mockReturnValue(
    new Promise(r => {
      resolve = r;
    }),
  );
  await render();
  await act(async () => {
    jest.advanceTimersByTime(20000);
  });
  expect(assets.fetchDepositRecords).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve({ items: [], total: 0 });
  });
  mockActive = false;
  await act(async () => {
    renderer.update(element());
  });
  await act(async () => {
    jest.advanceTimersByTime(20000);
  });
  expect(assets.fetchDepositRecords).toHaveBeenCalledTimes(1);
  mockActive = true;
  await act(async () => {
    renderer.update(element());
  });
  expect(assets.fetchDepositRecords).toHaveBeenCalledTimes(2);
});

it('ignores a late response from a previously selected address', async () => {
  let resolve!: (value: {
    items: assets.DepositRecord[];
    total: number;
  }) => void;
  jest.mocked(assets.fetchDepositRecords).mockReturnValueOnce(
    new Promise(r => {
      resolve = r;
    }),
  );
  await render();
  await act(async () => {
    renderer.update(element({ ...address, address: '0xNew' }));
  });
  await act(async () => {
    resolve({ items: [row], total: 1 });
  });
  expect(text()).not.toContain('0xtx');
});

it('validates the API data and filters out sender matches and other networks', async () => {
  jest.mocked(assets.fetchDepositRecords).mockRestore();
  const raw = {
    id: 7,
    symbol: 'USDT',
    chain_key: 'bsc',
    address: '0xabcd',
    amount: '5',
    status: 'CONFIRMED',
    confirmations: 15,
    confirm_required: 15,
  };
  jest
    .spyOn(apiClient, 'get')
    .mockResolvedValue({
      items: [
        raw,
        { ...raw, address: '0xOther' },
        { ...raw, chain_key: 'eth' },
      ],
      total: 3,
    });
  const result = await assets.fetchDepositRecords({ ...address, page: 1 });
  expect(result.items).toHaveLength(1);
  expect(result.items[0].credited).toBeNull();
  expect(depositStage(result.items[0])).toBe('confirmed');
  expect(() =>
    assets.normalizeDepositRecords({
      items: [{ ...raw, confirmations: -1 }],
      total: 1,
    }),
  ).toThrow();
  expect(() => assets.normalizeDepositRecords({ total: 1 })).toThrow();
  expect(depositStage({ ...row, status: 'UNKNOWN' })).toBe('unknown');
  expect(depositStage({ ...row, status: 'FAILED', credited: true })).toBe(
    'failed',
  );
});
