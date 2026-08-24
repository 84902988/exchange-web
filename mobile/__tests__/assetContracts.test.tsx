import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import {
  normalizeAssetBalanceLogsResponse,
  normalizeAssetBdOverview,
  normalizeAssetInviteOverview,
  normalizeAssetOptionsResponse,
  normalizeAccountTransferResponse,
  normalizeContractTransferResponse,
  normalizeDepositAddress,
  normalizeWithdrawCodeResponse,
  normalizeWithdrawConfirmResponse,
  normalizeWithdrawCreateResponse,
  normalizeWithdrawFeeEstimate,
} from '../src/api/assets';
import AssetBdSummary from '../src/components/assets/AssetBdSummary';
import AssetInviteSummary from '../src/components/assets/AssetInviteSummary';
import {
  buildWithdrawFeeFingerprint,
  isWithdrawOptionEnabled,
  isWithdrawFeeReady,
} from '../src/screens/assets/WithdrawScreen';
import {
  formatAssetLogRemark,
  mapAccountLabel,
  mapLogType,
} from '../src/screens/assets/AssetHistoryScreen';
import { createTranslator } from '../src/i18n';
import {
  compareNonNegativeDecimalText,
  isPositiveDecimalText,
  multiplyDecimalTextByPercent,
  normalizeNonNegativeDecimalText,
} from '../src/utils/decimalText';

const withdrawParams = {
  symbol: 'USDT',
  network: 'eth',
  toAddress: '0x1234567890',
  amount: '10',
};

describe('exact asset decimal helpers', () => {
  it('compares and calculates percentages without converting through Number', () => {
    const balance = '9007199254740992.123456789012345678';
    expect(normalizeNonNegativeDecimalText(`000${balance}`)).toBe(balance);
    expect(isPositiveDecimalText('0.000000000000000001')).toBe(true);
    expect(compareNonNegativeDecimalText(`${balance}1`, balance)).toBe(1);
    expect(multiplyDecimalTextByPercent(balance, 100)).toBe(balance);
    expect(multiplyDecimalTextByPercent('0.123456789012345678', 25)).toBe(
      '0.0308641972530864195',
    );
  });

  it('rejects exponent, negative and unbounded decimal input', () => {
    expect(normalizeNonNegativeDecimalText('1e6')).toBeNull();
    expect(normalizeNonNegativeDecimalText('-1')).toBeNull();
    expect(normalizeNonNegativeDecimalText('1'.repeat(49))).toBeNull();
  });
});

describe('asset list contracts', () => {
  it('distinguishes a real empty balance-log page from a malformed payload', () => {
    expect(
      normalizeAssetBalanceLogsResponse({
        items: [],
        page: 1,
        page_size: 20,
        total: 0,
      }),
    ).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });

    expect(() =>
      normalizeAssetBalanceLogsResponse({
        page: 1,
        page_size: 20,
        total: 0,
      }),
    ).toThrow('列表缺失');
    expect(() =>
      normalizeAssetBalanceLogsResponse({
        items: [{}],
        page: 1,
        page_size: 20,
        total: 1,
      }),
    ).toThrow('单号无效');
  });

  it('accepts a real empty options list and rejects missing or invalid rows', () => {
    expect(
      normalizeAssetOptionsResponse({
        items: [],
        default_asset_symbol: null,
      }),
    ).toEqual({ items: [], defaultAssetSymbol: null });

    expect(() => normalizeAssetOptionsResponse({})).toThrow('列表缺失');
    expect(() =>
      normalizeAssetOptionsResponse({
        items: [{}],
        default_asset_symbol: null,
      }),
    ).toThrow('币种缺失');

    expect(
      normalizeAssetOptionsResponse({
        items: [
          {
            coin_symbol: 'USDT',
            chain_key: 'eth',
            min_deposit: '0',
            min_withdraw: '1',
            withdraw_fee: '0.5',
            deposit_enabled: true,
            withdraw_enabled: true,
            enabled: true,
            asset_enabled: true,
            chain_enabled: true,
            asset_chain_enabled: true,
          },
        ],
        default_asset_symbol: 'USDT',
      }).items[0],
    ).toMatchObject({
      coinSymbol: 'USDT',
      chainKey: 'eth',
      withdrawFee: '0.5',
      withdrawEnabled: true,
    });
  });
});

describe('withdraw response contracts', () => {
  it('hides memo-required networks until the real submit contract supports a memo', () => {
    const option = {
      coinSymbol: 'XRP',
      chainKey: 'xrp',
      withdrawEnabled: true,
      enabled: true,
      assetEnabled: true,
      chainEnabled: true,
      assetChainEnabled: true,
    };
    expect(isWithdrawOptionEnabled(option)).toBe(true);
    expect(isWithdrawOptionEnabled({ ...option, memoRequired: true })).toBe(
      false,
    );
  });

  it('requires an explicit non-negative fee and fee coin', () => {
    const estimate = normalizeWithdrawFeeEstimate(
      {
        symbol: 'USDT',
        chain_key: 'eth',
        amount: '10',
        fee: '0',
        fee_coin: 'USDT',
        fee_currency: 'USDT',
      },
      withdrawParams,
    );
    expect(estimate).toMatchObject({ fee: '0', feeCoin: 'USDT' });

    const fingerprint = buildWithdrawFeeFingerprint({
      address: withdrawParams.toAddress,
      amount: withdrawParams.amount,
      network: withdrawParams.network,
      symbol: withdrawParams.symbol,
    });
    expect(isWithdrawFeeReady(estimate, fingerprint, fingerprint)).toBe(true);
    expect(
      isWithdrawFeeReady(
        estimate,
        fingerprint,
        buildWithdrawFeeFingerprint({
          ...withdrawParams,
          address: '0xchanged',
        }),
      ),
    ).toBe(false);

    expect(() =>
      normalizeWithdrawFeeEstimate({
        symbol: 'USDT',
        chain_key: 'eth',
        amount: '10',
        fee_coin: 'USDT',
        fee_currency: 'USDT',
      }),
    ).toThrow('提现手续费缺失');
    expect(() =>
      normalizeWithdrawFeeEstimate({
        symbol: 'USDT',
        chain_key: 'eth',
        amount: '10',
        fee: '0',
        fee_currency: 'USDT',
      }),
    ).toThrow('手续费币种缺失');
  });

  it('rejects a draft missing id, status, fee, or fee coin', () => {
    const validPayload: Record<string, unknown> = {
      withdraw_id: 9,
      symbol: 'USDT',
      chain_key: 'eth',
      to_address: '0x1234567890',
      amount: '10.000000',
      status: 'VERIFYING',
      need_manual_review: false,
      fee_estimate: '0.5',
      fee_coin: 'USDT',
    };
    expect(
      normalizeWithdrawCreateResponse(validPayload, withdrawParams),
    ).toMatchObject({
      withdrawId: 9,
      status: 'VERIFYING',
      feeEstimate: '0.5',
      feeCoin: 'USDT',
    });

    for (const field of ['withdraw_id', 'status', 'fee_estimate', 'fee_coin']) {
      const malformed = { ...validPayload };
      delete malformed[field];
      expect(() =>
        normalizeWithdrawCreateResponse(malformed, withdrawParams),
      ).toThrow();
    }
    expect(() =>
      normalizeWithdrawCreateResponse(
        { ...validPayload, withdraw_id: 0 },
        withdrawParams,
      ),
    ).toThrow('提现单号无效');
  });

  it('does not synthesize send-code or confirm identifiers and statuses', () => {
    expect(
      normalizeWithdrawCodeResponse({ withdraw_id: 9, status: 'VERIFYING' }, 9),
    ).toMatchObject({ withdrawId: 9, status: 'VERIFYING' });
    expect(() => normalizeWithdrawCodeResponse({ withdraw_id: 9 }, 9)).toThrow(
      '提现状态缺失',
    );
    expect(() =>
      normalizeWithdrawCodeResponse(
        { withdraw_id: 10, status: 'VERIFYING' },
        9,
      ),
    ).toThrow('单号与请求不一致');

    const validConfirm = {
      withdraw_id: 9,
      symbol: 'USDT',
      chain_key: 'eth',
      amount: '10',
      status: 'FROZEN',
      fee_final: '0.5',
      fee_coin: 'USDT',
    };
    expect(normalizeWithdrawConfirmResponse(validConfirm, 9)).toMatchObject({
      withdrawId: 9,
      status: 'FROZEN',
      feeFinal: '0.5',
      feeCoin: 'USDT',
    });
    expect(() =>
      normalizeWithdrawConfirmResponse(
        { ...validConfirm, fee_final: undefined },
        9,
      ),
    ).toThrow('最终手续费缺失');
  });
});

describe('asset history presentation', () => {
  it('maps internal account and transfer identifiers to product labels', () => {
    expect(mapLogType('USER_TRANSFER')).toBe('站内转账');
    expect(mapLogType('TRANSFER')).toBe('账户划转');
    expect(mapAccountLabel('funding')).toBe('资金账户');
    expect(mapAccountLabel('contract')).toBe('合约账户');
    expect(mapAccountLabel('unknown_internal_key')).toBe('其他账户');
  });

  it('never exposes internal English ledger remarks to users', () => {
    expect(mapLogType('CONTRACT_REALIZED_PNL')).toBe('合约已实现盈亏');
    expect(
      formatAssetLogRemark(
        'cancel unfreeze; available delta=10.000000000000000000',
        'UNFREEZE',
      ),
    ).toBe('撤单释放');
    expect(
      formatAssetLogRemark('contract close margin release', 'CLOSE_RELEASE'),
    ).toBe('平仓保证金释放');
    expect(formatAssetLogRemark('unknown internal detail', 'UNKNOWN')).toBe(
      '--',
    );
    expect(formatAssetLogRemark('用户备注', 'USER_TRANSFER')).toBe('用户备注');
  });

  it('localizes known ledger types and internal remarks without changing raw ids', () => {
    const t = createTranslator('en');
    expect(mapLogType('CONTRACT_REALIZED_PNL', t)).toBe(
      'Contract realized PnL',
    );
    expect(mapAccountLabel('funding', t)).toBe('Funding account');
    expect(
      formatAssetLogRemark('contract close margin release', 'CLOSE_RELEASE', t),
    ).toBe('Closing margin release');
    expect(formatAssetLogRemark('unknown internal detail', 'UNKNOWN', t)).toBe(
      '--',
    );
  });
});

describe('deposit and transfer success contracts', () => {
  it('requires a safe deposit address bound to the requested symbol and network', () => {
    const payload = {
      symbol: 'USDT',
      network: 'eth',
      chain_id: 1,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      memo: null,
      contract_address: null,
      decimals: 6,
      confirm_required: 12,
      deposit_enabled: true,
      withdraw_enabled: true,
      min_deposit: '0',
      notice: [],
    };
    expect(
      normalizeDepositAddress(payload, { symbol: 'USDT', network: 'eth' }),
    ).toMatchObject({
      symbol: 'USDT',
      network: 'eth',
      address: payload.address,
      memo: null,
      depositEnabled: true,
    });
    expect(() =>
      normalizeDepositAddress(
        { ...payload, address: '' },
        { symbol: 'USDT', network: 'eth' },
      ),
    ).toThrow('充值地址缺失');
    expect(() =>
      normalizeDepositAddress(
        { ...payload, network: 'tron' },
        { symbol: 'USDT', network: 'eth' },
      ),
    ).toThrow('充值网络与请求不一致');
  });

  it('accepts only a positive SUCCESS funding/spot transfer matching the request', () => {
    const params = {
      fromAccount: 'funding' as const,
      toAccount: 'spot' as const,
      symbol: 'USDT',
      amount: '10',
    };
    const payload = {
      record: {
        id: 21,
        transfer_no: 'ITR202607310001ABCDEF12',
        symbol: 'USDT',
        from_account: 'funding',
        to_account: 'spot',
        amount: '10.000000',
        status: 'SUCCESS',
        created_at: '2026-07-31T10:00:00',
      },
    };
    expect(normalizeAccountTransferResponse(payload, params)).toMatchObject({
      record: {
        id: 21,
        transferNo: 'ITR202607310001ABCDEF12',
        status: 'SUCCESS',
      },
    });
    expect(() =>
      normalizeAccountTransferResponse(
        { ...payload, record: { ...payload.record, id: 0 } },
        params,
      ),
    ).toThrow('划转记录 ID无效');
    expect(() =>
      normalizeAccountTransferResponse(
        { ...payload, record: { ...payload.record, status: 'PENDING' } },
        params,
      ),
    ).toThrow('划转状态不是成功');
    expect(() =>
      normalizeAccountTransferResponse(
        { ...payload, record: { ...payload.record, amount: '11' } },
        params,
      ),
    ).toThrow('划转数量与请求不一致');
  });

  it('requires the real contract transfer credential, direction, asset, and amount', () => {
    const payload = {
      transfer_no: 'CTI20260731120000ABCDEF12',
      direction: 'IN',
      margin_asset: 'USDT',
      amount: '10.000000',
      funding_available_before: '100',
      funding_available_after: '90',
      contract_available_before: '20',
      contract_available_after: '30',
    };
    expect(
      normalizeContractTransferResponse(payload, {
        direction: 'in',
        amount: '10',
      }),
    ).toMatchObject({
      transferNo: 'CTI20260731120000ABCDEF12',
      direction: 'IN',
      marginAsset: 'USDT',
      amount: '10.000000',
    });
    expect(() =>
      normalizeContractTransferResponse(
        { ...payload, transfer_no: '' },
        { direction: 'in', amount: '10' },
      ),
    ).toThrow('合约划转凭证缺失');
    expect(() =>
      normalizeContractTransferResponse(
        { ...payload, direction: 'OUT' },
        { direction: 'in', amount: '10' },
      ),
    ).toThrow('方向与请求不一致');
  });
});

describe('invite and BD overview contracts', () => {
  it('accepts authoritative invite zeros but rejects missing summary fields', () => {
    expect(
      normalizeAssetInviteOverview({
        invite_code: null,
        commission_percent: '15',
        summary: {
          invited_count: 0,
          total_commission_rcb: '0',
          pending_commission_rcb: '0',
          paid_commission_rcb: '0',
          commission_percent: '15.0',
        },
        recent_records: [],
      }),
    ).toEqual({
      inviteCode: null,
      inviteLink: null,
      commissionPercent: '15',
      invitedCount: 0,
      totalReward: '0',
      pendingReward: '0',
      paidReward: '0',
      rewardAsset: 'RCB',
      recentRecords: [],
    });
    expect(() =>
      normalizeAssetInviteOverview({
        commission_percent: '15',
        summary: {
          total_commission_rcb: '0',
          pending_commission_rcb: '0',
          paid_commission_rcb: '0',
          commission_percent: '15',
        },
        recent_records: [],
      }),
    ).toThrow('邀请人数无效');
  });

  it('uses per-asset BD commission maps and never appends MULTI', () => {
    const overview = normalizeAssetBdOverview({
      is_bd: true,
      account: { bd_level: 'L2', invite_code: 'BD-L2' },
      summary: {
        bound_user_count: 3,
        total_commission_by_asset: { RCB: '1.00', USDT: '2.00' },
        pending_commission_by_asset: { RCB: '0.25', USDT: '0.50' },
        paid_commission_by_asset: { RCB: '0.75', USDT: '1.50' },
        settlement_asset_symbol: 'MULTI',
      },
    });
    expect(overview).toMatchObject({
      isBd: true,
      inviteCode: 'BD-L2',
      totalCommission: '1.00 RCB / 2.00 USDT',
    });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetBdSummary
          isLoggedIn
          overview={overview}
          onLoginPress={jest.fn()}
        />,
      );
    });
    const renderedText = readRenderedText(renderer!);
    expect(renderedText).toContain('1.00 RCB / 2.00 USDT');
    expect(renderedText).toContain('invite_type=bd');
    expect(renderedText).not.toContain('MULTI');

    expect(() =>
      normalizeAssetBdOverview({
        is_bd: true,
        account: { bd_level: 'L2', invite_code: 'BD-L2' },
        summary: {
          bound_user_count: 3,
          pending_commission_by_asset: { RCB: '0' },
          paid_commission_by_asset: { RCB: '0' },
        },
      }),
    ).toThrow('累计佣金缺失');
    expect(normalizeAssetBdOverview({ is_bd: false })).toEqual({
      isBd: false,
      accountStatus: null,
    });
    expect(
      normalizeAssetBdOverview({
        is_bd: false,
        account: { status: 'DISABLED' },
      }),
    ).toEqual({ isBd: false, accountStatus: 'DISABLED' });
  });

  it('shows a loading state without inventing invite reward values', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetInviteSummary
          isLoggedIn
          loading
          overview={null}
          onLoginPress={jest.fn()}
        />,
      );
    });
    const renderedText = readRenderedText(renderer!);
    expect(renderedText).toContain('正在加载邀请数据');
    expect(renderedText).not.toContain('RCB');
  });
});

function readRenderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}
