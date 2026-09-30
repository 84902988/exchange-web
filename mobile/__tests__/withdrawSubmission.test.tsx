import React from 'react';
import { Alert, Text } from 'react-native';
import Renderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
} from '../src/i18n';
import * as assets from '../src/api/assets';
import { apiClient } from '../src/api/client';
import WithdrawScreen from '../src/screens/assets/WithdrawScreen';
import WithdrawRecords from '../src/components/assets/action/WithdrawRecords';
import {
  ActionTextField,
  SelectChips,
  SmallTextButton,
} from '../src/components/assets/action/ActionPrimitives';
import PrimaryButton from '../src/components/common/PrimaryButton';
import {
  canCancelWithdraw,
  canSendWithdraw,
  mapWithdrawStatus,
} from '../src/utils/withdrawStatus';
import {findWithdrawalConfirmation} from '../src/utils/withdrawConfirmation';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    require('react').useEffect(callback, [callback]),
}));
jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ isLoggedIn: true, user: { id: 1 } }),
}));
jest.mock('../src/hooks/useApplicationState', () => ({
  useApplicationActive: () => true,
}));
jest.mock('../src/components/common/AppScreen', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const row: assets.WithdrawRecord = {
  withdrawId: 82,
  symbol: 'USDT',
  chainKey: 'bsc',
  amount: '1',
  fee: '0.005',
  feeCoin: 'USDT',
  toAddress: '0x1234567890123456789012345678901234567890',
  status: 'FROZEN',
  txHash: '',
  createdAt: '2026-09-18T09:38:59',
};
let renderer: Renderer.ReactTestRenderer;
async function render(element: React.ReactElement) {
  await act(async () => {
    renderer = Renderer.create(<LanguageProvider>{element}</LanguageProvider>);
  });
}
function text() {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .join(' ');
}
function primary(title: string) {
  return renderer.root
    .findAllByType(PrimaryButton)
    .find(node => node.props.title === title)!;
}
function small(title: string) {
  return renderer.root
    .findAllByType(SmallTextButton)
    .find(node => node.props.title === title)!;
}
async function prepareVerify() {
  await render(<WithdrawScreen />);
  act(() => {
    renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === 'Withdrawal address')!
      .props.onChangeText(row.toAddress);
    renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === 'Amount')!
      .props.onChangeText('1');
  });
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  await act(async () => {
    await primary('Submit withdrawal request').props.onPress();
  });
  act(() => {
    renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'number-pad')!
      .props.onChangeText('123456');
  });
}

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  jest
    .spyOn(assets, 'fetchWithdrawOptions')
    .mockResolvedValue({
      items: [
        {
          coinSymbol: 'USDT',
          chainKey: 'bsc',
          minWithdraw: '0',
          withdrawEnabled: true,
        },
      ],
    });
  jest
    .spyOn(assets, 'fetchAssetAccountBalances')
    .mockResolvedValue([
      { symbol: 'USDT', accountKey: 'funding', available: 10, frozen: 0 },
    ]);
  jest
    .spyOn(assets, 'fetchWithdrawFee')
    .mockResolvedValue({
      symbol: 'USDT',
      chainKey: 'bsc',
      amount: '1',
      fee: '0.005',
      feeCoin: 'USDT',
      feeCurrency: 'USDT',
    });
  jest
    .spyOn(assets, 'createWithdrawDraft')
    .mockResolvedValue({
      ...row,
      feeEstimate: '0.005',
      status: 'VERIFYING',
      needManualReview: false,
    });
  jest
    .spyOn(assets, 'confirmWithdraw')
    .mockResolvedValue({ ...row, feeFinal: '0.005' });
  jest
    .spyOn(assets, 'sendWithdrawTx')
    .mockResolvedValue({ withdrawId: 82, status: 'PROCESSING' });
  jest
    .spyOn(assets, 'cancelWithdraw')
    .mockResolvedValue({ withdrawId: 82, status: 'CANCELED' });
  jest.spyOn(assets, 'fetchWithdrawRecords').mockResolvedValue([row]);
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('confirms once, then enqueues the same withdrawal once even on double tap', async () => {
  let resolve!: (value: assets.WithdrawConfirmResponse) => void;
  jest.mocked(assets.confirmWithdraw).mockReturnValue(
    new Promise(r => {
      resolve = r;
    }),
  );
  await prepareVerify();
  const button = renderer.root
    .findAllByType(PrimaryButton)
    .find(node => node.props.title === 'Confirm submission')!;
  let pending: Promise<void>;
  act(() => {
    pending = button.props.onPress();
    button.props.onPress();
  });
  expect(assets.confirmWithdraw).toHaveBeenCalledTimes(1);
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ ...row, feeFinal: '0.005' });
    await pending;
  });
  expect(assets.sendWithdrawTx).toHaveBeenCalledTimes(1);
  expect(assets.sendWithdrawTx).toHaveBeenCalledWith(82);
  expect(assets.createWithdrawDraft).toHaveBeenCalledTimes(1);
});

it('keeps a recoverable request after send timeout and refreshes to chain success', async () => {
  jest.mocked(assets.sendWithdrawTx).mockRejectedValue(new Error('timeout'));
  await prepareVerify();
  await act(async () => {
    await primary('Confirm submission').props.onPress();
  });
  expect(text()).toContain('Chain submission is unconfirmed');
  expect(small('Continue submission')).toBeDefined();
  jest
    .mocked(assets.fetchWithdrawRecords)
    .mockResolvedValue([{ ...row, status: 'SUCCESS', txHash: '0xtx' }]);
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(text()).toContain('Completed');
  expect(text()).not.toContain('Chain submission is unconfirmed');
  expect(assets.sendWithdrawTx).toHaveBeenCalledTimes(1);
});

it('does not send when verification fails or a draft requires review', async () => {
  jest
    .mocked(assets.confirmWithdraw)
    .mockRejectedValue(new Error('invalid code'));
  jest.mocked(assets.fetchWithdrawRecords).mockResolvedValue([{...row, status: 'VERIFYING'}]);
  await prepareVerify();
  await act(async () => {
    await primary('Confirm submission').props.onPress();
  });
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  expect(primary('Confirm submission')).toBeDefined();
  act(() => renderer.unmount());
  jest
    .mocked(assets.createWithdrawDraft)
    .mockResolvedValue({
      ...row,
      feeEstimate: '0.005',
      status: 'REVIEWING',
      needManualReview: true,
    });
  await render(<WithdrawScreen />);
  act(() => {
    renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === 'Withdrawal address')!
      .props.onChangeText(row.toAddress);
    renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === 'Amount')!
      .props.onChangeText('1');
  });
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
  await act(async () => {
    await primary('Submit withdrawal request').props.onPress();
  });
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
});

it.each(['FROZEN', 'APPROVED', 'PROCESSING', 'SENT', 'SUCCESS', 'FAILED', 'CANCELED'])(
  'reconciles a lost confirm response to %s without repeating a money operation', async status => {
    jest.mocked(assets.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    const record = {...row, status, txHash: ['SENT', 'SUCCESS'].includes(status) ? '0xtx' : ''};
    jest.mocked(assets.fetchWithdrawRecords).mockResolvedValue([record]);
    await prepareVerify();
    await act(async () => { await primary('Confirm submission').props.onPress(); });
    expect(text()).toContain(mapWithdrawStatus(status, createTranslator('en')));
    expect(primary('Confirm submission')).toBeUndefined();
    expect(text()).not.toContain('Confirmation pending');
    if (['FROZEN', 'APPROVED'].includes(status)) expect(small('Continue submission')).toBeDefined();
    if (record.txHash) expect(small('Continue submission')).toBeUndefined();
    expect(assets.confirmWithdraw).toHaveBeenCalledTimes(1);
    expect(assets.createWithdrawDraft).toHaveBeenCalledTimes(1);
    expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  },
);

it.each(['read error', 'missing id', 'unknown status'])(
  'keeps %s pending, blocks another draft and resolves through an explicit read', async kind => {
    jest.mocked(assets.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    if (kind === 'read error') jest.mocked(assets.fetchWithdrawRecords).mockRejectedValue(new Error('offline'));
    else jest.mocked(assets.fetchWithdrawRecords).mockResolvedValue(
      kind === 'missing id' ? [{...row, withdrawId: 99}] : [{...row, status: 'UNRECOGNIZED'}],
    );
    await prepareVerify();
    const originalConfirm = primary('Confirm submission').props.onPress;
    await act(async () => { await originalConfirm(); });
    expect(text()).toContain('Confirmation pending');
    expect(primary('Make another withdrawal').props.disabled).toBe(true);
    expect(primary('Confirm submission')).toBeUndefined();
    expect(text()).not.toContain('Withdrawal failed');
    // Even a retained event callback cannot issue a second confirmation.
    await act(async () => { await originalConfirm(); });
    jest.mocked(assets.fetchWithdrawRecords).mockResolvedValue([{...row, status: 'SENT', txHash: '0xtx'}]);
    await act(async () => { await primary('Refresh request status').props.onPress(); });
    expect(text()).not.toContain('Confirmation pending');
    expect(text()).toContain(mapWithdrawStatus('SENT', createTranslator('en')));
    expect(assets.confirmWithdraw).toHaveBeenCalledTimes(1);
    expect(assets.createWithdrawDraft).toHaveBeenCalledTimes(1);
    expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  },
);

it('guards rapid confirmation and coin switching while reconciling, then ignores unmounted reads', async () => {
  let rejectConfirm!: (error: Error) => void;
  let resolveRead!: (rows: assets.WithdrawRecord[]) => void;
  jest.mocked(assets.confirmWithdraw).mockReturnValue(new Promise((_, reject) => { rejectConfirm = reject; }));
  jest.mocked(assets.fetchWithdrawRecords).mockReturnValue(new Promise(resolve => { resolveRead = resolve; }));
  await prepareVerify();
  const confirm = primary('Confirm submission').props.onPress;
  let pending: Promise<void>;
  act(() => {
    pending = confirm();
    confirm();
    renderer.root.findAllByType(SelectChips).find(node => node.props.value === 'USDT')!.props.onChange('OTHER');
  });
  await act(async () => { rejectConfirm(new Error('timeout')); });
  expect(text()).toContain('Confirmation pending');
  expect(assets.confirmWithdraw).toHaveBeenCalledTimes(1);
  const readCount = jest.mocked(assets.fetchWithdrawRecords).mock.calls.length;
  act(() => renderer.unmount());
  await act(async () => { resolveRead([row]); await pending!; });
  expect(assets.fetchWithdrawRecords).toHaveBeenCalledTimes(readCount);
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  expect(assets.createWithdrawDraft).toHaveBeenCalledTimes(1);
});

it('does not send if confirmation resolves after leaving the screen', async () => {
  let resolve!: (result: assets.WithdrawConfirmResponse) => void;
  jest.mocked(assets.confirmWithdraw).mockReturnValue(new Promise(done => { resolve = done; }));
  await prepareVerify();
  let pending: Promise<void>;
  act(() => { pending = primary('Confirm submission').props.onPress(); });
  act(() => renderer.unmount());
  await act(async () => { resolve({...row, feeFinal: row.fee}); await pending!; });
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  expect(assets.fetchWithdrawRecords).not.toHaveBeenCalled();
});

it('finds only the original id, paginates read-only and bounds a missing request', async () => {
  const firstPage = Array.from({length: 20}, (_, i) => ({...row, withdrawId: 200 + i}));
  const read = jest.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce([row]);
  expect(await findWithdrawalConfirmation(82, read)).toEqual(row);
  expect(read.mock.calls).toEqual([[0], [20]]);
  read.mockReset().mockResolvedValue(firstPage);
  expect(await findWithdrawalConfirmation(82, read)).toBeNull();
  expect(read.mock.calls).toEqual([[0], [20], [40], [60], [80]]);
});

it('recovers old requests after reopening with explicit confirmation and no new freeze', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const changed = jest.fn();
  await render(
    <WithdrawRecords revision={0} disabled={false} onChange={changed} />,
  );
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  act(() => small('Continue submission').props.onPress());
  expect(alert.mock.calls[0][1]).toContain(row.toAddress);
  expect(assets.sendWithdrawTx).not.toHaveBeenCalled();
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(assets.sendWithdrawTx).toHaveBeenCalledWith(82);
  expect(assets.confirmWithdraw).not.toHaveBeenCalled();
  expect(assets.createWithdrawDraft).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledWith([{ ...row, status: 'PROCESSING' }]);
});

it('cancels only on explicit confirmation and hides actions once broadcast', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  await render(
    <WithdrawRecords revision={0} disabled={false} onChange={jest.fn()} />,
  );
  act(() => small('Cancel withdrawal').props.onPress());
  expect(assets.cancelWithdraw).not.toHaveBeenCalled();
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(assets.cancelWithdraw).toHaveBeenCalledWith(82);
  expect(text()).toContain('Canceled');
  expect(canSendWithdraw('FROZEN', '0xtx')).toBe(false);
  expect(canCancelWithdraw('FROZEN', '0xtx')).toBe(false);
  expect(canCancelWithdraw('SENDING', '')).toBe(false);
  expect(mapWithdrawStatus('SENT', createTranslator('en'))).not.toBe(
    mapWithdrawStatus('SUCCESS', createTranslator('en')),
  );
});

it('uses the send query contract without blind retries and rejects mismatched responses', async () => {
  jest.mocked(assets.sendWithdrawTx).mockRestore();
  const post = jest
    .spyOn(apiClient, 'post')
    .mockResolvedValue({ ok: true, status: 'PROCESSING', withdraw_id: 82 });
  await assets.sendWithdrawTx(82);
  expect(post).toHaveBeenCalledWith(
    '/asset/withdraw/send?withdraw_id=82',
    {},
    { retry: 'none' },
  );
  expect(() =>
    assets.normalizeWithdrawSendResponse(
      { ok: true, status: 'PROCESSING', withdraw_id: 99 },
      82,
    ),
  ).toThrow();
  expect(() =>
    assets.normalizeWithdrawSendResponse(
      { ok: false, status: 'FROZEN', withdraw_id: 82 },
      82,
    ),
  ).toThrow();
  expect(() => assets.normalizeWithdrawRecords({})).toThrow();
});
