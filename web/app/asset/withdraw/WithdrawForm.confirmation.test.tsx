import React from 'react';
import {afterEach, beforeEach, expect, it, jest} from '@jest/globals';
import '@testing-library/jest-dom/jest-globals';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import WithdrawForm from './WithdrawForm';
import WithdrawRecords from './WithdrawRecords';
import AssetsAPI from '@/lib/api/modules/assets';
import UserTransferAPI from '@/lib/api/modules/user_transfer';
import WithdrawAPI from '@/lib/api/modules/assets_withdraw';
import {getWithdrawStatusMeta} from './withdraw.shared';
import {findWithdrawalConfirmation} from './withdrawConfirmation';

jest.mock('@/contexts/LocaleContext', () => {
  const t = (key: string) => key;
  return {useLocaleContext: () => ({t})};
});
jest.mock('@/components/asset/CoinSelect', () => ({__esModule: true, default: () => null}));
jest.mock('@/components/asset/NetworkSelect', () => ({__esModule: true, default: () => null}));
jest.mock('@/lib/api', () => ({ApiError: class ApiError extends Error {}}));
jest.mock('@/lib/api/modules/assets_withdraw', () => ({
  __esModule: true,
  default: {
    createWithdraw: jest.fn(), confirmWithdraw: jest.fn(), getWithdrawFee: jest.fn(),
    sendWithdrawCode: jest.fn(), sendWithdrawTx: jest.fn(), listWithdraws: jest.fn(),
  },
}));
jest.mock('@/lib/api/modules/user_transfer', () => ({__esModule: true, default: {getRecords: jest.fn()}}));
jest.mock('@/lib/api/modules/assets', () => ({__esModule: true, default: {getWithdraws: jest.fn()}}));
jest.mock('@/lib/authContext', () => ({useAuth: () => ({userIdentityKey: 'user:1'})}));

const row = {withdraw_id: 82, status: 'FROZEN', symbol: 'USDT', chain_key: 'bsc',
  to_address: '0x1234567890123456789012345678901234567890', amount: '1', fee: '0.005'};
let client: QueryClient;
let props: React.ComponentProps<typeof WithdrawForm>;
let view: ReturnType<typeof render>;
const element = () => <QueryClientProvider client={client}><WithdrawForm {...props}/></QueryClientProvider>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  props = {currentLanguage: 'en', coinSymbol: 'USDT', networkCode: 'bsc',
    setCoinSymbol: jest.fn(), setNetworkCode: jest.fn(), onToast: jest.fn(), onError: jest.fn(), onSuccessVerified: jest.fn(),
    withdrawOptions: [{coin_symbol: 'USDT', chain_key: 'bsc', withdraw_enabled: true, min_withdraw: '0', withdraw_fee: '0.005'}],
    balances: [{symbol: 'USDT', account_key: 'funding', available: '10', frozen: '0'}]};
  jest.mocked(WithdrawAPI.getWithdrawFee).mockResolvedValue({fee: '0.005', fee_coin: 'USDT'});
  jest.mocked(WithdrawAPI.createWithdraw).mockResolvedValue({...row, status: 'VERIFYING'});
  jest.mocked(WithdrawAPI.confirmWithdraw).mockResolvedValue({...row, fee_final: row.fee});
  jest.mocked(WithdrawAPI.sendWithdrawTx).mockResolvedValue({ok: true, withdraw_id: 82, status: 'PROCESSING'});
  jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [row], limit: 20, offset: 0});
  jest.mocked(WithdrawAPI.sendWithdrawCode).mockResolvedValue({withdraw_id: 82, status: 'VERIFYING'});
  jest.mocked(AssetsAPI.getWithdraws).mockResolvedValue({items: [row], limit: 20, offset: 0});
  jest.mocked(UserTransferAPI.getRecords).mockResolvedValue({items: [], total: 0, page: 1, page_size: 20});
});
afterEach(() => { view?.unmount(); client.clear(); jest.useRealTimers(); });

async function prepareVerify() {
  view = render(element());
  fireEvent.change(screen.getByPlaceholderText('withdrawAddressPlaceholder'), {target: {value: row.to_address}});
  fireEvent.change(screen.getByPlaceholderText('assetWithdrawPleaseEnterAmount'), {target: {value: '1'}});
  await act(async () => { jest.advanceTimersByTime(500); });
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawSubmitOnChainWithdraw'}));
  await waitFor(() => expect(screen.getByPlaceholderText('assetWithdrawPleaseEnterVerificationCode')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('assetWithdrawPleaseEnterVerificationCode'), {target: {value: '123456'}});
  await act(async () => { jest.advanceTimersByTime(500); });
}
const confirmButton = () => screen.getByRole('button', {name: 'assetWithdrawConfirmSubmit'});

it('preserves the once-only normal confirm then send path during rapid clicks', async () => {
  let resolve!: (value: typeof row) => void;
  jest.mocked(WithdrawAPI.confirmWithdraw).mockReturnValue(new Promise(done => { resolve = done; }));
  await prepareVerify();
  const button = confirmButton();
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', {name: 'assetWithdrawPrevious'})).toBeDisabled();
  await act(async () => { resolve(row); });
  await waitFor(() => expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1));
  expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledWith({withdraw_id: 82});
  expect(WithdrawAPI.listWithdraws).not.toHaveBeenCalled();
  expect(WithdrawAPI.createWithdraw).toHaveBeenCalledTimes(1);
});

it.each(['FROZEN', 'APPROVED', 'PROCESSING', 'SENT', 'SUCCESS', 'FAILED', 'CANCELED'])(
  'uses an authoritative %s record after a lost confirmation response without automatic sending', async status => {
    jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status}], limit: 20, offset: 0});
    // A pre-confirm list snapshot must not undo the newly reconciled state.
    props.latestWithdrawRecords = [{...row, status: 'VERIFYING'}];
    await prepareVerify();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText(getWithdrawStatusMeta(status).title)).toBeInTheDocument());
    expect(screen.queryByRole('button', {name: 'assetWithdrawConfirmSubmit'})).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmation pending')).not.toBeInTheDocument();
    expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
    expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1);
    expect(WithdrawAPI.createWithdraw).toHaveBeenCalledTimes(1);
  },
);

it('retains email verification only after reading VERIFYING', async () => {
  jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('invalid code'));
  jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status: 'VERIFYING'}], limit: 20, offset: 0});
  await prepareVerify();
  fireEvent.click(confirmButton());
  await waitFor(() => expect(WithdrawAPI.listWithdraws).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(confirmButton()).toBeEnabled());
  expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
  expect(screen.queryByText('withdrawStatusFailedTitle')).not.toBeInTheDocument();
});

it.each(['read error', 'missing id', 'unknown status'])(
  'keeps %s pending and refreshes the same id without another mutation', async kind => {
    jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    if (kind === 'read error') jest.mocked(WithdrawAPI.listWithdraws).mockRejectedValue(new Error('offline'));
    else jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [kind === 'missing id'
      ? {...row, withdraw_id: 99} : {...row, status: 'UNKNOWN_NEW_STATUS'}], limit: 20, offset: 0});
    await prepareVerify();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByRole('button', {name: 'Refresh request status'})).toBeEnabled());
    expect(screen.getAllByText('Confirmation pending').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', {name: 'assetWithdrawMakeAnother'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'assetWithdrawDone'})).toBeDisabled();
    expect(screen.queryByText('withdrawStatusFailedTitle')).not.toBeInTheDocument();
    jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status: 'SUCCESS', tx_hash: '0xtx'}], limit: 20, offset: 0});
    fireEvent.click(screen.getByRole('button', {name: 'Refresh request status'}));
    await waitFor(() => expect(screen.getByText('withdrawStatusSuccessTitle')).toBeInTheDocument());
    expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1);
    expect(WithdrawAPI.createWithdraw).toHaveBeenCalledTimes(1);
    expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
  },
);

it.each(['unmount', 'coin change'])(
  'ignores a late confirmation after %s without sending', async action => {
    let resolve!: (value: typeof row) => void;
    jest.mocked(WithdrawAPI.confirmWithdraw).mockReturnValue(new Promise(done => { resolve = done; }));
    await prepareVerify();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1));
    if (action === 'unmount') view.unmount();
    else { props.coinSymbol = 'OTHER'; view.rerender(element()); }
    await act(async () => { resolve(row); jest.advanceTimersByTime(100); });
    expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
    expect(WithdrawAPI.listWithdraws).not.toHaveBeenCalled();
    expect(props.onSuccessVerified).not.toHaveBeenCalled();
  },
);

it('matches only the original id and bounds read-only pagination', async () => {
  const rows = Array.from({length: 20}, (_, i) => ({...row, withdraw_id: 200 + i}));
  const read = jest.fn<(offset: number) => Promise<typeof row[]>>().mockResolvedValueOnce(rows).mockResolvedValueOnce([row]);
  expect(await findWithdrawalConfirmation(82, read)).toEqual(row);
  expect(read.mock.calls).toEqual([[0], [20]]);
  read.mockReset().mockResolvedValue(rows);
  expect(await findWithdrawalConfirmation(82, read)).toBeNull();
  expect(read.mock.calls).toEqual([[0], [20], [40], [60], [80]]);
});

const recordsElement = (coinSymbol = 'USDT', networkCode = 'bsc') => <QueryClientProvider client={client}><WithdrawRecords
  currentLanguage="en" coinSymbol={coinSymbol} networkCode={networkCode} copiedKey="" onCopy={jest.fn(async () => {})}
/></QueryClientProvider>;

async function prepareRecordVerify() {
  jest.mocked(AssetsAPI.getWithdraws).mockResolvedValue({items: [{...row, status: 'VERIFYING'}], limit: 20, offset: 0});
  view = render(recordsElement());
  await waitFor(() => expect(screen.getByRole('button', {name: 'assetWithdrawRecordsVerify'})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsVerify'}));
  await waitFor(() => expect(screen.getByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).toBeInTheDocument());
  fireEvent.change(screen.getByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode'), {target: {value: '123456'}});
}

it.each([
  ['FROZEN', '', true], ['APPROVED', '', true], ['APPROVED', '0xtx', false],
  ['FROZEN', '0xtx', false], ['SENT', '0xtx', false],
])('records %s with tx=%s expose submit=%s only on explicit action', async (status, tx_hash, canSubmit) => {
  jest.mocked(AssetsAPI.getWithdraws).mockResolvedValue({items: [{...row, status: String(status), tx_hash: String(tx_hash)}], limit: 20, offset: 0});
  view = render(recordsElement());
  await waitFor(() => expect(screen.getByText('USDT')).toBeInTheDocument());
  const submit = screen.queryByRole('button', {name: 'assetWithdrawRecordsSubmit'});
  if (canSubmit) expect(submit).toBeEnabled();
  else expect(submit).not.toBeInTheDocument();
  expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
});

it.each(['FROZEN', 'APPROVED', 'SENT'])(
  'record verification reconciles timeout to %s and removes the stale code panel', async status => {
    jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status}], limit: 20, offset: 0});
    await prepareRecordVerify();
    fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'}));
    await waitFor(() => expect(WithdrawAPI.listWithdraws).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).not.toBeInTheDocument());
    expect(screen.queryByText('assetWithdrawRecordsConfirmationFailedPleaseTryAgainLater')).not.toBeInTheDocument();
    if (status !== 'SENT') expect(screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'})).toBeEnabled();
    expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
    expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1);
  },
);

it('records retain pending confirmation and recover by explicit refresh without retrying confirmation', async () => {
  jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('timeout'));
  jest.mocked(WithdrawAPI.listWithdraws).mockRejectedValue(new Error('offline'));
  await prepareRecordVerify();
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'}));
  await waitFor(() => expect(screen.getByRole('button', {name: 'Refresh request status'})).toBeEnabled());
  expect(screen.queryByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', {name: 'assetWithdrawRecordsVerify'})).not.toBeInTheDocument();
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.getByText('Confirmation pending · #82')).toBeInTheDocument();
  jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status: 'SUCCESS', tx_hash: '0xtx'}], limit: 20, offset: 0});
  fireEvent.click(screen.getByRole('button', {name: 'Refresh request status'}));
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Refresh request status'})).not.toBeInTheDocument());
  expect(screen.getAllByText('withdrawStatusSuccessBadge').length).toBeGreaterThan(0);
  expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1);
  expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
});

it('record verification returns to VERIFYING only after an authoritative read', async () => {
  jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('invalid code'));
  jest.mocked(WithdrawAPI.listWithdraws).mockResolvedValue({items: [{...row, status: 'VERIFYING'}], limit: 20, offset: 0});
  await prepareRecordVerify();
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'}));
  await waitFor(() => expect(WithdrawAPI.listWithdraws).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).toBeInTheDocument());
  expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
});

it.each([false, true])('record verification guards rapid clicks and unmount=%s', async unmount => {
  let resolve!: (value: typeof row) => void;
  jest.mocked(WithdrawAPI.confirmWithdraw).mockReturnValue(new Promise(done => { resolve = done; }));
  await prepareRecordVerify();
  const button = screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'});
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(WithdrawAPI.confirmWithdraw).toHaveBeenCalledTimes(1));
  if (unmount) view.unmount();
  await act(async () => { resolve(row); });
  if (unmount) expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
  else await waitFor(() => expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1));
});

it.each(['confirm', 'recovery'])('record %s completion after changing context and returning releases UI busy state', async stage => {
  let finish!: () => void;
  if (stage === 'confirm') {
    jest.mocked(WithdrawAPI.confirmWithdraw).mockReturnValue(new Promise(resolve => { finish = () => resolve(row); }));
  } else {
    jest.mocked(WithdrawAPI.confirmWithdraw).mockRejectedValue(new Error('timeout'));
    jest.mocked(WithdrawAPI.listWithdraws).mockReturnValue(new Promise(resolve => {
      finish = () => resolve({items: [row], limit: 20, offset: 0});
    }));
  }
  await prepareRecordVerify();
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'}));
  await waitFor(() => expect(stage === 'confirm' ? WithdrawAPI.confirmWithdraw : WithdrawAPI.listWithdraws).toHaveBeenCalledTimes(1));
  view.rerender(recordsElement('OTHER', 'other-network'));
  view.rerender(recordsElement());
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getByRole('button', {name: 'assetWithdrawRecordsVerify'})).toBeEnabled());
  expect(screen.queryByRole('button', {name: 'Refresh request status'})).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).not.toBeInTheDocument();
  expect(WithdrawAPI.sendWithdrawTx).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsVerify'}));
  await waitFor(() => expect(screen.getByPlaceholderText('assetWithdrawRecordsPleaseEnterVerificationCode')).toBeInTheDocument());
  expect(WithdrawAPI.sendWithdrawCode).toHaveBeenCalledTimes(2);
});

it('blocks explicit submit and cancel while automatic send is pending and the refetched record is FROZEN', async () => {
  let finish!: () => void;
  jest.mocked(WithdrawAPI.sendWithdrawTx).mockReturnValue(new Promise(resolve => {
    finish = () => resolve({ok: true, status: 'PROCESSING', withdraw_id: 82});
  }));
  await prepareRecordVerify();
  jest.mocked(AssetsAPI.getWithdraws).mockResolvedValue({items: [row], limit: 20, offset: 0});
  fireEvent.click(screen.getByRole('button', {name: 'assetWithdrawRecordsConfirmWithdraw'}));
  await waitFor(() => expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'})).toBeDisabled());
  const submit = screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'});
  const cancel = screen.getByRole('button', {name: 'assetWithdrawRecordsCancel'});
  expect(cancel).toBeDisabled();
  fireEvent.click(submit); fireEvent.click(submit); fireEvent.click(cancel);
  expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  await waitFor(() => expect(submit).toBeEnabled());
  expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1);
});

it('serializes explicit send double clicks with other record actions', async () => {
  let finish!: () => void;
  jest.mocked(WithdrawAPI.sendWithdrawTx).mockReturnValue(new Promise(resolve => {
    finish = () => resolve({ok: true, status: 'PROCESSING', withdraw_id: 82});
  }));
  view = render(recordsElement());
  await waitFor(() => expect(screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'})).toBeEnabled());
  const submit = screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'});
  act(() => { submit.click(); submit.click(); });
  expect(WithdrawAPI.sendWithdrawTx).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', {name: 'assetWithdrawRecordsCancel'})).toBeDisabled();
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getByRole('button', {name: 'assetWithdrawRecordsSubmit'})).toBeEnabled());
});
