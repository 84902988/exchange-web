import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Alert, Text, TextInput } from 'react-native';
import {
  createAssetBdApplication,
  normalizeAssetBdApplication,
  type AssetBdApplication,
} from '../src/api/assets';
import { apiClient } from '../src/api/client';
import AssetBdSummary from '../src/components/assets/AssetBdSummary';

const pendingApplication: AssetBdApplication = {
  id: 9,
  applyLevel: 'BD2',
  depositCoinSymbol: 'USDT',
  depositAmount: '1000',
  status: 'PENDING',
  remark: 'team lead',
  adminRemark: null,
  createdAt: '2026-08-05 10:00:00',
  updatedAt: '2026-08-05 10:00:00',
  reviewedAt: null,
};

describe('mobile partner application contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes an authoritative application and real empty state', () => {
    expect(normalizeAssetBdApplication(null)).toBeNull();
    expect(
      normalizeAssetBdApplication({
        id: 9,
        apply_level: 'bd2',
        deposit_coin_symbol: 'usdt',
        deposit_amount: '1000',
        status: 'pending',
        remark: 'team lead',
        admin_remark: null,
        created_at: '2026-08-05 10:00:00',
        updated_at: '2026-08-05 10:00:00',
        reviewed_at: null,
      }),
    ).toEqual(pendingApplication);

    expect(() =>
      normalizeAssetBdApplication({
        ...pendingApplication,
        apply_level: 'BD4',
      }),
    ).toThrow('代理申请等级无效');
  });

  it('posts the existing backend contract once with retry disabled', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      id: 10,
      apply_level: 'BD3',
      deposit_coin_symbol: 'RCB',
      deposit_amount: '2500',
      status: 'PENDING',
      remark: 'channel team',
      admin_remark: null,
      created_at: '2026-08-05 11:00:00',
      updated_at: '2026-08-05 11:00:00',
      reviewed_at: null,
    });

    await expect(
      createAssetBdApplication({
        applyLevel: 'BD3',
        depositCoinSymbol: 'RCB',
        depositAmount: '002500.00',
        remark: '  channel team  ',
      }),
    ).resolves.toMatchObject({
      id: 10,
      applyLevel: 'BD3',
      depositAmount: '2500',
      status: 'PENDING',
    });
    expect(post).toHaveBeenCalledWith(
      '/bd/my/application',
      {
        apply_level: 'BD3',
        deposit_coin_symbol: 'RCB',
        deposit_amount: '2500',
        remark: 'channel team',
      },
      { retry: 'none' },
    );
  });

  it('shows a visible apply action and requires confirmation before callback', () => {
    const onApply = jest.fn();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetBdSummary
          isLoggedIn
          overview={{ isBd: false, accountStatus: null }}
          onApply={onApply}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const applyButton = renderer!.root
      .findAll(node => node.props.accessibilityLabel === '申请成为代理')
      .at(0);
    expect(applyButton).toBeDefined();
    act(() => applyButton!.props.onPress());

    const amountInput = renderer!.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === '预计保证金金额');
    expect(amountInput).toBeDefined();
    act(() => amountInput!.props.onChangeText('1e6'));

    const submitButton = renderer!.root
      .findAll(node => node.props.accessibilityLabel === '提交代理申请')
      .at(0);
    act(() => submitButton!.props.onPress());
    expect(readRenderedText(renderer!)).toContain(
      '请输入大于或等于 0 的有效金额',
    );
    expect(alert).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    act(() => amountInput!.props.onChangeText('2500.00'));
    act(() => {
      submitButton!.props.onPress();
      submitButton!.props.onPress();
    });
    expect(alert).toHaveBeenCalledWith(
      '确认提交代理申请',
      expect.stringContaining('本次提交不会扣除或冻结资金'),
      expect.any(Array),
      expect.any(Object),
    );
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0][2];
    const confirmButton = buttons?.find(button => button.text === '确认提交');
    act(() => confirmButton?.onPress?.());
    expect(onApply).toHaveBeenCalledWith({
      applyLevel: 'BD1',
      depositCoinSymbol: 'USDT',
      depositAmount: '2500',
      remark: '',
    });
  });

  it('fails closed while pending and shows the original admin review note', () => {
    let pendingRenderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      pendingRenderer = ReactTestRenderer.create(
        <AssetBdSummary
          application={pendingApplication}
          isLoggedIn
          overview={{ isBd: false, accountStatus: null }}
          onApply={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(readRenderedText(pendingRenderer!)).toContain('审核中');
    expect(
      pendingRenderer!.root.findAll(
        node => node.props.accessibilityLabel === '申请成为代理',
      ).length > 0,
    ).toBe(false);

    let rejectedRenderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      rejectedRenderer = ReactTestRenderer.create(
        <AssetBdSummary
          application={{
            ...pendingApplication,
            status: 'REJECTED',
            adminRemark: 'Please add your channel plan.',
          }}
          isLoggedIn
          overview={{ isBd: false, accountStatus: null }}
          onApply={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(readRenderedText(rejectedRenderer!)).toContain(
      'Please add your channel plan.',
    );
    expect(
      rejectedRenderer!.root.findAll(
        node => node.props.accessibilityLabel === '重新提交申请',
      ).length > 0,
    ).toBe(true);
  });

  it('does not expose an application action when account status or request state is unsafe', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetBdSummary
          applicationError="代理申请状态加载失败，请稍后重试"
          isLoggedIn
          overview={{ isBd: false, accountStatus: null }}
          onApply={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(readRenderedText(renderer!)).toContain('代理申请状态暂不可用');
    expect(
      renderer!.root.findAll(
        node => node.props.accessibilityLabel === '申请成为代理',
      ).length > 0,
    ).toBe(false);

    act(() => {
      renderer!.update(
        <AssetBdSummary
          isLoggedIn
          overview={{ isBd: false, accountStatus: 'DISABLED' }}
          onApply={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(readRenderedText(renderer!)).toContain('代理资格不可用');
    expect(
      renderer!.root.findAll(
        node => node.props.accessibilityLabel === '申请成为代理',
      ).length > 0,
    ).toBe(false);
  });
});

function readRenderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}
