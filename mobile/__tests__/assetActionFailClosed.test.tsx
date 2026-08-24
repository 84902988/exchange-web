import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import QRCode from 'react-native-qrcode-svg';
import PrimaryButton from '../src/components/common/PrimaryButton';
import {
  ActionTextField,
  CopyIconButton,
  SelectChips,
} from '../src/components/assets/action/ActionPrimitives';

const mockFetchAssetAccountBalances = jest.fn();
const mockFetchDepositAddress = jest.fn();
const mockFetchDepositOptions = jest.fn();
const mockSubmitContractTransfer = jest.fn();
const mockSubmitFundingSpotTransfer = jest.fn();
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: mockNavigate,
  }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ isLoggedIn: true }),
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
    submitContractTransfer: (...args: unknown[]) =>
      mockSubmitContractTransfer(...args),
    submitFundingSpotTransfer: (...args: unknown[]) =>
      mockSubmitFundingSpotTransfer(...args),
  };
});

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import DepositScreen from '../src/screens/assets/DepositScreen';
import TransferScreen from '../src/screens/assets/TransferScreen';

describe('asset action screens fail closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDepositOptions.mockResolvedValue({
      items: [
        {
          coinSymbol: 'USDT',
          chainKey: 'eth',
          chainName: 'Ethereum',
          minDeposit: '0',
          minWithdraw: '1',
          withdrawFee: '0.5',
          depositEnabled: true,
          withdrawEnabled: true,
          enabled: true,
          assetEnabled: true,
          chainEnabled: true,
          assetChainEnabled: true,
        },
      ],
      defaultAssetSymbol: 'USDT',
    });
    mockFetchAssetAccountBalances.mockResolvedValue([
      {
        symbol: 'USDT',
        accountKey: 'funding',
        available: 100,
        frozen: 0,
      },
    ]);
  });

  it('opens the read-only user transfer record center from transfer', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TransferScreen />);
      await Promise.resolve();
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '查看站内转账记录' })
        .props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('UserTransferRecords');
    act(() => renderer.unmount());
  });

  it('keeps the deposit selection and exposes an address-contract failure', async () => {
    mockFetchDepositAddress.mockRejectedValue(
      new Error('充值地址响应格式无效，请稍后重试'),
    );
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<DepositScreen />);
      await Promise.resolve();
    });

    const getAddressButton = renderer!.root
      .findAllByType(PrimaryButton)
      .find(node => node.props.title === '获取充值地址');
    expect(getAddressButton).toBeDefined();
    await act(async () => {
      await getAddressButton!.props.onPress();
    });

    const selectors = renderer!.root.findAllByType(SelectChips);
    expect(selectors.map(node => node.props.value)).toEqual(['USDT', 'eth']);
    expect(selectors.map(node => node.props.searchable)).toEqual([true, true]);
    expect(readRenderedText(renderer!)).toContain('充值地址响应格式无效');
    expect(renderer!.root.findAllByType(CopyIconButton)).toHaveLength(0);
  });

  it('renders a scannable QR code from the exact backend deposit address', async () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    mockFetchDepositAddress.mockResolvedValue({
      address,
      memo: null,
      symbol: 'USDT',
      network: 'eth',
      minDeposit: '0',
      confirmRequired: 12,
      notice: [],
    });
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<DepositScreen />);
      await Promise.resolve();
    });

    const getAddressButton = renderer!.root
      .findAllByType(PrimaryButton)
      .find(node => node.props.title === '获取充值地址');
    await act(async () => {
      await getAddressButton!.props.onPress();
    });

    expect(renderer!.root.findByType(QRCode).props.value).toBe(address);
    expect(
      renderer!.root.findByProps({
        accessibilityLabel: 'USDT eth 充值地址二维码',
      }),
    ).toBeDefined();
    expect(renderer!.root.findAllByType(CopyIconButton)).toHaveLength(1);
    act(() => renderer!.unmount());
  });

  it('deduplicates address requests and aborts the active read on unmount', async () => {
    let resolveAddress!: (value: {
      address: string;
      memo: null;
      symbol: string;
      network: string;
      minDeposit: string;
      confirmRequired: number;
      notice: never[];
    }) => void;
    mockFetchDepositAddress.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAddress = resolve;
        }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<DepositScreen />);
      await Promise.resolve();
    });

    const getAddressButton = renderer.root.findAllByType(PrimaryButton)[0];
    act(() => {
      getAddressButton!.props.onPress();
      getAddressButton!.props.onPress();
    });
    expect(mockFetchDepositAddress).toHaveBeenCalledTimes(1);
    const signal = mockFetchDepositAddress.mock.calls[0][1]
      .signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => renderer.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveAddress({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        memo: null,
        symbol: 'USDT',
        network: 'eth',
        minDeposit: '0',
        confirmRequired: 12,
        notice: [],
      });
      await Promise.resolve();
    });
  });

  it('retains the transfer amount and never reports success for an invalid receipt', async () => {
    mockSubmitFundingSpotTransfer.mockRejectedValue(
      new Error('账户划转响应格式无效，请稍后重试'),
    );
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TransferScreen />);
      await Promise.resolve();
    });

    const amountField = renderer!.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    expect(amountField).toBeDefined();
    act(() => {
      amountField!.props.onChangeText('10');
    });

    const submitButton = renderer!.root
      .findAllByType(PrimaryButton)
      .find(node => node.props.title === '确认划转');
    expect(submitButton?.props.disabled).toBe(false);
    await act(async () => {
      await submitButton!.props.onPress();
    });

    const currentAmountField = renderer!.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    const renderedText = readRenderedText(renderer!);
    expect(currentAmountField?.props.value).toBe('10');
    expect(renderedText).toContain('账户划转响应格式无效');
    expect(renderedText).not.toContain('划转成功');
  });

  it('also keeps contract-transfer input when its success credential is invalid', async () => {
    mockSubmitContractTransfer.mockRejectedValue(
      new Error('合约划转响应格式无效，请稍后重试'),
    );
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TransferScreen />);
      await Promise.resolve();
    });

    const toAccount = renderer!.root
      .findAllByType(SelectChips)
      .find(node => node.props.label === '转入账户');
    act(() => {
      toAccount!.props.onChange('contract');
    });
    const amountField = renderer!.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    act(() => {
      amountField!.props.onChangeText('12');
    });
    const submitButton = renderer!.root
      .findAllByType(PrimaryButton)
      .find(node => node.props.title === '确认划转');
    await act(async () => {
      await submitButton!.props.onPress();
    });

    expect(mockSubmitContractTransfer).toHaveBeenCalledWith({
      direction: 'in',
      amount: '12',
    });
    const currentAmountField = renderer!.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    const renderedText = readRenderedText(renderer!);
    expect(currentAmountField?.props.value).toBe('12');
    expect(renderedText).toContain('合约划转响应格式无效');
    expect(renderedText).not.toContain('划转成功');
  });

  it('keeps the exact backend decimal when selecting all available balance', async () => {
    const exactBalance = '9007199254740992.123456789012345678';
    mockFetchAssetAccountBalances.mockResolvedValue([
      {
        symbol: 'USDT',
        accountKey: 'funding',
        available: Number(exactBalance),
        frozen: 0,
        availableText: exactBalance,
        frozenText: '0',
      },
    ]);
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<TransferScreen />);
      await Promise.resolve();
    });

    act(() => {
      renderer!.root
        .findByProps({ accessibilityLabel: '全部' })
        .props.onPress();
    });

    const amountField = renderer!.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    expect(amountField?.props.value).toBe(exactBalance);
  });
});

function readRenderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}
