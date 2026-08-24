import React from 'react';
import { Share, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { normalizeAssetInviteOverview } from '../src/api/assets';
import AssetInviteCommissionRecords, {
  inviteCommissionStatusLabel,
} from '../src/components/assets/AssetInviteCommissionRecords';
import AssetInviteSummary, {
  buildInviteShareMessage,
} from '../src/components/assets/AssetInviteSummary';
import { buildInviteRegistrationLink } from '../src/utils/inviteLink';

const payload = {
  invite_code: 'INVITE88',
  invite_link: 'https://exchange.example/register?invite_code=INVITE88&invite_type=user',
  commission_percent: '15',
  summary: {
    invited_count: 2,
    total_commission_rcb: '3.5',
    pending_commission_rcb: '1.25',
    paid_commission_rcb: '2.25',
    commission_percent: '15.0',
  },
  recent_records: [
    {
      id: 9,
      invitee_user_id: 21,
      fee_coin_symbol: 'USDT',
      fee_amount: '0.4',
      fee_usdt_value: '0.4',
      commission_rate: '0.15',
      commission_rcb_amount: '0.03',
      status: 'PAID',
      created_at: '2026-08-05T01:02:03',
      paid_at: '2026-08-05T02:03:04',
    },
  ],
};

describe('mobile invite center parity', () => {
  it('builds typed registration links and encodes invite codes', () => {
    expect(
      buildInviteRegistrationLink(
        'https://exchange.example',
        ' BD CODE ',
        'bd',
      ),
    ).toBe(
      'https://exchange.example/register?invite_code=BD+CODE&invite_type=bd',
    );
    expect(buildInviteRegistrationLink('invalid', 'INVITE88', 'user')).toBe(
      '',
    );
  });

  it('normalizes authoritative percentage and recent reward records', () => {
    expect(normalizeAssetInviteOverview(payload)).toEqual({
      inviteCode: 'INVITE88',
      inviteLink:
        'https://exchange.example/register?invite_code=INVITE88&invite_type=user',
      commissionPercent: '15',
      invitedCount: 2,
      totalReward: '3.5',
      pendingReward: '1.25',
      paidReward: '2.25',
      rewardAsset: 'RCB',
      recentRecords: [
        {
          id: 9,
          inviteeUserId: 21,
          feeCoinSymbol: 'USDT',
          feeAmount: '0.4',
          feeUsdtValue: '0.4',
          commissionRate: '0.15',
          commissionRcbAmount: '0.03',
          status: 'PAID',
          createdAt: '2026-08-05T01:02:03',
          paidAt: '2026-08-05T02:03:04',
        },
      ],
    });
  });

  it('fails closed on inconsistent percentages, duplicate rows, and invalid paid state', () => {
    expect(() =>
      normalizeAssetInviteOverview({
        ...payload,
        summary: { ...payload.summary, commission_percent: '16' },
      }),
    ).toThrow('邀请返佣比例不一致');
    expect(() =>
      normalizeAssetInviteOverview({
        ...payload,
        recent_records: [payload.recent_records[0], payload.recent_records[0]],
      }),
    ).toThrow('邀请奖励记录重复');
    expect(() =>
      normalizeAssetInviteOverview({
        ...payload,
        recent_records: [{ ...payload.recent_records[0], paid_at: null }],
      }),
    ).toThrow('邀请奖励状态与发放时间不一致');
  });

  it('shares the registration link through the system share sheet', async () => {
    const overview = normalizeAssetInviteOverview(payload);
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction });
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetInviteSummary
          isLoggedIn
          overview={overview}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(renderedText(renderer!)).toContain('返佣 15%');
    expect(renderedText(renderer!)).toContain('invite_type=user');
    expect(
      buildInviteShareMessage(
        ' INVITE88 ',
        ' https://exchange.example/register?invite_code=INVITE88&invite_type=user ',
      ),
    ).toBe(
      'Exchange 邀请链接：https://exchange.example/register?invite_code=INVITE88&invite_type=user\n邀请码：INVITE88',
    );
    await act(async () => {
      await renderer!.root
        .findByProps({ accessibilityLabel: '分享邀请链接' })
        .props.onPress();
    });
    expect(shareSpy).toHaveBeenCalledWith({
      title: 'Exchange 邀请链接',
      message:
        'Exchange 邀请链接：https://exchange.example/register?invite_code=INVITE88&invite_type=user\n邀请码：INVITE88',
    });
    expect(renderedText(renderer!)).toContain('已打开系统分享');
    shareSpy.mockRestore();
  });

  it('renders recent records and truthful empty state', () => {
    const overview = normalizeAssetInviteOverview(payload);
    let populated: ReactTestRenderer.ReactTestRenderer;
    let empty: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      populated = ReactTestRenderer.create(
        <AssetInviteCommissionRecords items={overview.recentRecords} />,
      );
      empty = ReactTestRenderer.create(
        <AssetInviteCommissionRecords items={[]} />,
      );
    });
    expect(renderedText(populated!)).toContain('受邀用户 UID 21');
    expect(renderedText(populated!)).toContain('0.03 RCB');
    expect(renderedText(populated!)).toContain('已发放');
    expect(renderedText(empty!)).toContain('暂无邀请奖励记录');
    expect(inviteCommissionStatusLabel('FAILED')).toBe('发放失败');
  });
});

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}
