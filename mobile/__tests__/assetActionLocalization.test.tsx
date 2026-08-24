import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import PrimaryButton from '../src/components/common/PrimaryButton';
import {
  assetActionEn,
  assetActionJa,
  assetActionZhCN,
  assetActionZhTW,
} from '../src/i18n/assetActionCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
} from '../src/i18n';

const mockFetchAssetAccountBalances = jest.fn();
const mockFetchDepositAddress = jest.fn();
const mockFetchDepositOptions = jest.fn();
const mockFetchWithdrawFee = jest.fn();
const mockFetchWithdrawOptions = jest.fn();
const mockCreateWithdrawDraft = jest.fn();
const mockSendWithdrawCode = jest.fn();
const mockConfirmWithdraw = jest.fn();
const mockSubmitContractTransfer = jest.fn();
const mockSubmitFundingSpotTransfer = jest.fn();
const mockFetchUserTransferRecords = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({goBack: jest.fn(), navigate: jest.fn()}),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({isLoggedIn: true}),
}));

jest.mock('../src/api/assets', () => {
  const actual = jest.requireActual('../src/api/assets');
  return {
    ...actual,
    fetchAssetAccountBalances: (...args: unknown[]) =>
      mockFetchAssetAccountBalances(...args),
    fetchDepositAddress: (...args: unknown[]) =>
      mockFetchDepositAddress(...args),
    fetchDepositOptions: (...args: unknown[]) =>
      mockFetchDepositOptions(...args),
    fetchWithdrawFee: (...args: unknown[]) => mockFetchWithdrawFee(...args),
    fetchWithdrawOptions: (...args: unknown[]) =>
      mockFetchWithdrawOptions(...args),
    createWithdrawDraft: (...args: unknown[]) =>
      mockCreateWithdrawDraft(...args),
    sendWithdrawCode: (...args: unknown[]) => mockSendWithdrawCode(...args),
    confirmWithdraw: (...args: unknown[]) => mockConfirmWithdraw(...args),
    submitContractTransfer: (...args: unknown[]) =>
      mockSubmitContractTransfer(...args),
    submitFundingSpotTransfer: (...args: unknown[]) =>
      mockSubmitFundingSpotTransfer(...args),
  };
});

jest.mock('../src/api/userTransfer', () => {
  const actual = jest.requireActual('../src/api/userTransfer');
  return {
    ...actual,
    fetchUserTransferRecords: (...args: unknown[]) =>
      mockFetchUserTransferRecords(...args),
  };
});

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({children}: {children?: React.ReactNode}) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import DepositScreen from '../src/screens/assets/DepositScreen';
import TransferScreen from '../src/screens/assets/TransferScreen';
import UserTransferRecordsScreen from '../src/screens/assets/UserTransferRecordsScreen';
import WithdrawScreen from '../src/screens/assets/WithdrawScreen';

const option = {
  coinSymbol: 'USDT',
  chainKey: 'eth',
  chainName: 'Ethereum',
  minDeposit: '1',
  minWithdraw: '10',
  withdrawFee: '0.5',
  confirmations: 12,
  depositEnabled: true,
  withdrawEnabled: true,
  enabled: true,
  assetEnabled: true,
  chainEnabled: true,
  assetChainEnabled: true,
};

describe('asset action localization and write guards', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    mockFetchDepositOptions.mockResolvedValue({
      items: [option],
      defaultAssetSymbol: 'USDT',
    });
    mockFetchWithdrawOptions.mockResolvedValue({
      items: [option],
      defaultAssetSymbol: 'USDT',
    });
    mockFetchAssetAccountBalances.mockResolvedValue([
      {
        symbol: 'USDT',
        accountKey: 'funding',
        available: 100,
        availableText: '100',
        frozen: 0,
        frozenText: '0',
      },
    ]);
    mockFetchUserTransferRecords.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it('keeps every asset action key explicit in all four languages', () => {
    const expectedKeys = Object.keys(assetActionZhCN).sort();
    expect(expectedKeys.length).toBeGreaterThan(100);
    expect(Object.keys(assetActionZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(assetActionEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(assetActionJa).sort()).toEqual(expectedKeys);
    expect(
      createTranslator('en')('withdraw.minimumAmount', {
        amount: '10',
        symbol: 'USDT',
      }),
    ).toBe('Minimum withdrawal is 10 USDT');
    expect(
      createTranslator('ja')('withdraw.resendAfter', {seconds: 60}),
    ).toBe('60秒後に再送');
  });

  it('renders deposit in English without requesting or creating an address', async () => {
    const renderer = await renderWithEnglish(<DepositScreen />);
    const text = renderedText(renderer);
    expect(text).toContain('Deposit');
    expect(text).toContain('Get deposit address');
    expect(text).toContain('Minimum deposit');
    expect(text).not.toContain('充值');
    expect(mockFetchDepositOptions).toHaveBeenCalledTimes(1);
    expect(mockFetchDepositAddress).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders withdrawal in English without starting any withdrawal step', async () => {
    const renderer = await renderWithEnglish(<WithdrawScreen />);
    const text = renderedText(renderer);
    expect(text).toContain('Withdraw');
    expect(text).toContain('Withdrawal address');
    expect(text).toContain('Submit withdrawal request');
    expect(text).not.toContain('提现');
    expect(mockFetchWithdrawOptions).toHaveBeenCalledTimes(1);
    expect(mockFetchWithdrawFee).not.toHaveBeenCalled();
    expect(mockCreateWithdrawDraft).not.toHaveBeenCalled();
    expect(mockSendWithdrawCode).not.toHaveBeenCalled();
    expect(mockConfirmWithdraw).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders transfer in English without submitting a balance change', async () => {
    const renderer = await renderWithEnglish(<TransferScreen />);
    const text = renderedText(renderer);
    expect(text).toContain('Transfer');
    expect(text).toContain('Funding account');
    expect(text).toContain('Spot account');
    expect(
      renderer.root
        .findAllByType(PrimaryButton)
        .some(node => node.props.title === 'Confirm transfer'),
    ).toBe(true);
    expect(text).not.toContain('划转');
    expect(mockSubmitContractTransfer).not.toHaveBeenCalled();
    expect(mockSubmitFundingSpotTransfer).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders the linked internal transfer record page in English', async () => {
    const renderer = await renderWithEnglish(<UserTransferRecordsScreen />);
    const text = renderedText(renderer);
    expect(text).toContain('Internal transfer records');
    expect(text).toContain('No internal transfer records');
    expect(text).toContain('incoming and outgoing internal transfers');
    expect(text).not.toContain('站内转账');
    expect(mockFetchUserTransferRecords).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

async function renderWithEnglish(element: React.ReactElement) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <LanguageProvider>{element}</LanguageProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}
