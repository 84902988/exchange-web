import React from 'react';
import { Alert, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import PrimaryButton from '../src/components/common/PrimaryButton';
import {
  ActionTextField,
  SmallTextButton,
} from '../src/components/assets/action/ActionPrimitives';
import type { PendingUserTransferIntent } from '../src/services/pendingUserTransferIntent';
import type { UserTransferRecord } from '../src/api/userTransfer';

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockFetchBalances = jest.fn();
const mockResolveRecipient = jest.fn();
const mockCreateTransfer = jest.fn();
const mockRecoverIntent = jest.fn();
const mockSaveIntent = jest.fn();
const mockClearIntent = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ isLoggedIn: true, user: { id: 7 } }),
}));

jest.mock('../src/api/assets', () => {
  const actual = jest.requireActual('../src/api/assets');
  return {
    ...actual,
    fetchAssetAccountBalances: (...args: unknown[]) =>
      mockFetchBalances(...args),
  };
});

jest.mock('../src/api/userTransfer', () => {
  const actual = jest.requireActual('../src/api/userTransfer');
  return {
    ...actual,
    resolveUserTransferRecipient: (...args: unknown[]) =>
      mockResolveRecipient(...args),
    createUserTransfer: (...args: unknown[]) => mockCreateTransfer(...args),
  };
});

jest.mock('../src/services/pendingUserTransferIntent', () => {
  const actual = jest.requireActual(
    '../src/services/pendingUserTransferIntent',
  );
  return {
    ...actual,
    recoverPendingUserTransferIntent: (...args: unknown[]) =>
      mockRecoverIntent(...args),
    savePendingUserTransferIntent: (...args: unknown[]) =>
      mockSaveIntent(...args),
    clearPendingUserTransferIntent: (...args: unknown[]) =>
      mockClearIntent(...args),
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

import UserTransferScreen from '../src/screens/assets/UserTransferScreen';

const completedRecord: UserTransferRecord = {
  id: 1,
  transferNo: 'UTR202608140001',
  requestId: 'mobile-request-1',
  direction: 'out',
  counterpartyUserId: 202,
  counterpartyNickname: 'Alice',
  recipientNickname: 'Alice',
  recipientEmailMask: 'a***e@example.com',
  symbol: 'USDT',
  amount: '12.5',
  feeAmount: '0',
  netAmount: '12.5',
  status: 'SUCCESS',
  remark: '午餐',
  createdAt: '2026-08-14T08:00:00',
};

describe('mobile user transfer submission', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockFetchBalances.mockResolvedValue([
      {
        symbol: 'USDT',
        accountKey: 'funding',
        available: 100,
        frozen: 0,
        availableText: '100.00000001',
        frozenText: '0',
      },
    ]);
    mockRecoverIntent.mockResolvedValue({
      status: 'NONE',
      intent: null,
      authority: null,
    });
    mockResolveRecipient.mockResolvedValue({
      userId: 202,
      emailMask: 'a***e@example.com',
      nickname: 'Alice',
      canTransfer: true,
    });
    mockCreateTransfer.mockResolvedValue(completedRecord);
    mockSaveIntent.mockResolvedValue(undefined);
    mockClearIntent.mockResolvedValue(true);
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('requires recipient resolution, confirms, persists intent, then submits', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '收款人注册邮箱');
    act(() => emailField?.props.onChangeText('Alice@Example.com'));
    expect(
      renderer.root
        .findAllByType(PrimaryButton)
        .find(node => node.props.title === '提交站内转账')?.props.disabled,
    ).toBe(true);

    const resolveButton = renderer.root
      .findAllByType(SmallTextButton)
      .find(node => node.props.title === '确认收款人');
    await act(async () => {
      await resolveButton?.props.onPress();
    });
    expect(mockResolveRecipient).toHaveBeenCalledWith(
      'alice@example.com',
      expect.objectContaining({ signal: expect.any(Object) }),
    );

    const amountField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '数量');
    const remarkField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.label === '备注（选填）');
    act(() => {
      amountField?.props.onChangeText('12.5');
      remarkField?.props.onChangeText('午餐');
    });
    const submitButton = renderer.root
      .findAllByType(PrimaryButton)
      .find(node => node.props.title === '提交站内转账');
    expect(submitButton?.props.disabled).toBe(false);
    act(() => submitButton?.props.onPress());
    const confirmButton = alertSpy.mock.calls[0][2]?.find(
      (button: { text?: string }) => button.text === '确认转账',
    );

    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockSaveIntent).toHaveBeenCalledTimes(1);
    const intent = mockSaveIntent.mock.calls[0][0] as PendingUserTransferIntent;
    expect(intent).toMatchObject({
      ownerKey: '7',
      recipientUserId: 202,
      recipientEmail: 'alice@example.com',
      symbol: 'USDT',
      amount: '12.5',
      remark: '午餐',
    });
    expect(mockCreateTransfer).toHaveBeenCalledWith({
      requestId: intent.requestId,
      recipientEmail: 'alice@example.com',
      recipientUserId: 202,
      symbol: 'USDT',
      amount: '12.5',
      remark: '午餐',
    });
    expect(mockSaveIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateTransfer.mock.invocationCallOrder[0],
    );
    expect(mockClearIntent).toHaveBeenCalledWith(intent);
    expect(renderedText(renderer)).toContain('站内转账已完成');
    act(() => renderer.unmount());
  });

  it('opens one confirmation and submits once during rapid repeated presses', async () => {
    let resolveCreate!: (record: UserTransferRecord) => void;
    mockCreateTransfer.mockImplementationOnce(
      () =>
        new Promise<UserTransferRecord>(resolve => {
          resolveCreate = resolve;
        }),
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    let emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    act(() => emailField?.props.onChangeText('Alice@Example.com'));
    emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    await act(async () => {
      await emailField?.props.right.props.onPress();
    });

    const amountField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'decimal-pad');
    act(() => amountField?.props.onChangeText('12.5'));
    const submitButton = renderer.root.findAllByType(PrimaryButton)[0];
    act(() => {
      submitButton.props.onPress();
      submitButton.props.onPress();
    });
    expect(alertSpy).toHaveBeenCalledTimes(1);

    const confirmButton = alertSpy.mock.calls[0][2]?.[1];
    let firstSubmit!: Promise<void>;
    let secondSubmit!: Promise<void>;
    act(() => {
      firstSubmit = confirmButton.onPress();
      secondSubmit = confirmButton.onPress();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSaveIntent).toHaveBeenCalledTimes(1);
    expect(mockCreateTransfer).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate(completedRecord);
      await firstSubmit;
      await secondSubmit;
    });
    expect(mockClearIntent).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('discards a stale recipient response after the email changes', async () => {
    let resolveFirst!: (value: {
      userId: number;
      emailMask: string;
      nickname: string;
      canTransfer: boolean;
    }) => void;
    mockResolveRecipient
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        userId: 303,
        emailMask: 'b***b@example.com',
        nickname: 'Bob',
        canTransfer: true,
      });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    let emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    act(() => emailField?.props.onChangeText('alice@example.com'));
    emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    let firstResolve!: Promise<void>;
    act(() => {
      firstResolve = emailField?.props.right.props.onPress();
    });
    const firstSignal = mockResolveRecipient.mock.calls[0][1]
      .signal as AbortSignal;

    emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    act(() => emailField?.props.onChangeText('bob@example.com'));
    expect(firstSignal.aborted).toBe(true);
    emailField = renderer.root
      .findAllByType(ActionTextField)
      .find(node => node.props.keyboardType === 'email-address');
    await act(async () => {
      await emailField?.props.right.props.onPress();
    });
    expect(renderedText(renderer)).toContain('Bob');

    await act(async () => {
      resolveFirst({
        userId: 202,
        emailMask: 'a***e@example.com',
        nickname: 'Alice',
        canTransfer: true,
      });
      await firstResolve;
    });
    expect(renderedText(renderer)).toContain('Bob');
    expect(renderedText(renderer)).not.toContain('Alice');
    act(() => renderer.unmount());
  });

  it('restores an unresolved intent as an exact locked retry', async () => {
    const pending: PendingUserTransferIntent = {
      version: 1,
      ownerKey: '7',
      requestId: 'mobile-pending-1',
      recipientUserId: 202,
      recipientEmail: 'alice@example.com',
      symbol: 'USDT',
      amount: '8',
      remark: null,
      createdAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_604_800_000,
    };
    mockRecoverIntent.mockResolvedValue({
      status: 'NOT_FOUND',
      intent: pending,
      authority: {
        requestId: pending.requestId,
        state: 'NOT_FOUND',
        record: null,
      },
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<UserTransferScreen />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findAllByType(ActionTextField)
        .filter(node => ['收款人注册邮箱', '数量'].includes(node.props.label))
        .every(node => node.props.editable === false),
    ).toBe(true);
    expect(
      renderer.root
        .findAllByType(PrimaryButton)
        .some(node => node.props.title === '重试原转账'),
    ).toBe(true);
    expect(renderedText(renderer)).toContain('仅允许使用完全相同');
    act(() => renderer.unmount());
  });
});

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}
