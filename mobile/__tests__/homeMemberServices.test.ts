import { apiClient } from '../src/api/client';
import {
  addSupportTicketMessage,
  closeSupportTicket,
  createSupportTicket,
  fetchSupportTicketDetail,
  fetchSupportTickets,
  markSupportTicketRead,
} from '../src/api/support';
import {
  createRcbLock,
  fetchVipFeePreference,
  fetchRcbLocks,
  fetchVipOverview,
  releaseMaturedRcbLocks,
  updateVipFeePreference,
} from '../src/api/vip';
import { formatFeePercent } from '../src/screens/home/VipCenterScreen';
import { pickTargetLevel } from '../src/screens/home/RcbLockScreen';

describe('logged-in home member services', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('normalizes the authenticated VIP overview without inventing rates', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      auth_state: 'authenticated',
      rcb_fee_pay_percent: '80',
      user_summary: {
        effective_level_code: 'VIP1',
        effective_fee_source: 'VIP',
        effective_spot_maker_fee: '0.001',
        effective_spot_taker_fee: '0.0015',
        volume_30d: '25000',
        rcb_available: '20',
        rcb_locked: '10',
      },
      vip_levels: [
        {
          level_code: 'VIP1',
          level_name: 'VIP 1',
          sort_order: 1,
          spot_maker_fee: '0.001',
          spot_taker_fee: '0.0015',
          condition: { min_30d_volume: '10000', min_rcb_hold: '5' },
        },
      ],
      svip_levels: [],
    });

    await expect(fetchVipOverview()).resolves.toMatchObject({
      effectiveLevelCode: 'VIP1',
      effectiveSpotMakerFee: '0.001',
      vipLevels: [{ levelCode: 'VIP1', min30dVolume: '10000' }],
    });
    expect(formatFeePercent('0.0015')).toBe('0.15%');
  });

  it('rejects unauthenticated or malformed VIP responses', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      auth_state: 'anonymous',
      user_summary: {},
      vip_levels: [],
      svip_levels: [],
    });
    await expect(fetchVipOverview()).rejects.toThrow('登录状态已失效');
  });

  it('loads and updates the account-owned RCB fee preference without replay', async () => {
    const get = jest
      .spyOn(apiClient, 'get')
      .mockResolvedValue({use_rcb_fee: false});
    await expect(fetchVipFeePreference()).resolves.toEqual({useRcbFee: false});
    expect(get).toHaveBeenCalledWith('/vip/fee-preference');

    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValue({use_rcb_fee: true});
    await expect(updateVipFeePreference(true)).resolves.toEqual({
      useRcbFee: true,
    });
    expect(post).toHaveBeenCalledWith(
      '/vip/fee-preference',
      {use_rcb_fee: true},
      {retry: 'none'},
    );
  });

  it('fails closed when the RCB fee preference is not a strict boolean', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({use_rcb_fee: 1});
    await expect(fetchVipFeePreference()).rejects.toThrow(
      'RCB 手续费抵扣偏好响应格式无效',
    );
  });

  it('loads support ticket summaries and the real reply conversation', async () => {
    const listPayload = {
      items: [
        {
          id: 12,
          ticket_no: 'TK202608020001',
          category: 'TRADING',
          category_label: '交易问题',
          subject: '订单咨询',
          content: '请协助核查',
          status: 'REPLIED',
          status_label: '已回复',
          created_at: '2026-08-02T09:00:00',
          updated_at: '2026-08-02T09:10:00',
          has_unread_admin_reply: true,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      pages: 1,
      categories: [
        {value: 'ACCOUNT', label: '账户问题'},
        {value: 'TRADING', label: '交易问题'},
      ],
      statuses: [
        {value: 'OPEN', label: '待处理'},
        {value: 'REPLIED', label: '已回复'},
      ],
      unread_reply_count: 1,
    };
    const detailPayload = {
      ...listPayload.items[0],
      messages: [
        {
          id: 21,
          sender_type: 'ADMIN',
          message: '已为你核查完成',
          created_at: '2026-08-02T09:10:00',
        },
      ],
    };
    jest
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce(listPayload)
      .mockResolvedValueOnce(detailPayload);

    await expect(fetchSupportTickets()).resolves.toMatchObject({
      total: 1,
      pageSize: 20,
      categories: [
        {value: 'ACCOUNT', label: '账户问题'},
        {value: 'TRADING', label: '交易问题'},
      ],
      items: [{ id: 12, category: 'TRADING', status: 'REPLIED', messages: [] }],
    });
    await expect(fetchSupportTicketDetail(12)).resolves.toMatchObject({
      id: 12,
      messages: [{ senderType: 'ADMIN', message: '已为你核查完成' }],
    });
  });

  it('creates, replies to and closes support tickets without network replay', async () => {
    const baseTicket = {
      id: 13,
      ticket_no: 'TK202608020002',
      category: 'ACCOUNT',
      category_label: '账户问题',
      subject: '登录问题',
      content: '无法完成登录',
      status: 'OPEN',
      status_label: '待处理',
      has_unread_admin_reply: false,
      created_at: '2026-08-02T10:00:00',
      updated_at: '2026-08-02T10:00:00',
      messages: [
        {
          id: 30,
          sender_type: 'USER',
          message: '无法完成登录',
          created_at: '2026-08-02T10:00:00',
        },
      ],
    };
    const post = jest
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce(baseTicket)
      .mockResolvedValueOnce({
        ...baseTicket,
        updated_at: '2026-08-02T10:05:00',
        messages: [
          ...baseTicket.messages,
          {
            id: 31,
            sender_type: 'USER',
            message: '补充信息',
            created_at: '2026-08-02T10:05:00',
          },
        ],
      })
      .mockResolvedValueOnce({
        ...baseTicket,
        status: 'CLOSED',
        status_label: '已关闭',
      });

    await expect(
      createSupportTicket({
        category: 'ACCOUNT',
        subject: ' 登录问题 ',
        content: ' 无法完成登录 ',
      }),
    ).resolves.toMatchObject({id: 13, subject: '登录问题'});
    expect(post).toHaveBeenNthCalledWith(
      1,
      '/user/support-tickets',
      {category: 'ACCOUNT', subject: '登录问题', content: '无法完成登录'},
      {retry: 'none'},
    );

    await expect(addSupportTicketMessage(13, ' 补充信息 ')).resolves.toMatchObject({
      messages: [{id: 30}, {id: 31, message: '补充信息'}],
    });
    expect(post).toHaveBeenNthCalledWith(
      2,
      '/user/support-tickets/13/messages',
      {message: '补充信息'},
      {retry: 'none'},
    );

    await expect(closeSupportTicket(13)).resolves.toMatchObject({
      status: 'CLOSED',
    });
    expect(post).toHaveBeenNthCalledWith(
      3,
      '/user/support-tickets/13/close',
      {},
      {retry: 'none'},
    );
  });

  it('marks only the exact support message cursor without network replay', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      ok: true,
      last_read_message_id: 31,
      unread_reply_count: 0,
    });
    await expect(markSupportTicketRead(13, 31)).resolves.toEqual({
      lastReadMessageId: 31,
      unreadReplyCount: 0,
    });
    expect(post).toHaveBeenCalledWith(
      '/user/support-tickets/13/read',
      {last_seen_message_id: 31},
      {retry: 'none', signal: undefined},
    );
  });

  it('normalizes RCB lock records and sends the server-validated lock contract', async () => {
    jest.spyOn(apiClient, 'get').mockResolvedValue({
      items: [
        {
          id: 8,
          asset_symbol: 'RCB',
          lock_amount: '1200.000000000000000000',
          lock_period_days: 365,
          start_time: '2026-08-02T10:00:00',
          end_time: '2027-08-02T10:00:00',
          status: 'LOCKED',
          current_svip: 'SVIP1',
          created_at: '2026-08-02T10:00:00',
        },
      ],
    });
    await expect(fetchRcbLocks()).resolves.toMatchObject([
      {id: 8, lockAmount: '1200.000000000000000000', status: 'LOCKED'},
    ]);

    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      lock: {
        id: 9,
        asset_symbol: 'RCB',
        lock_amount: '1000.000000000000000000',
        lock_period_days: 365,
        start_time: '2026-08-02T11:00:00',
        end_time: '2027-08-02T11:00:00',
        status: 'LOCKED',
        current_svip: 'SVIP1',
        created_at: '2026-08-02T11:00:00',
      },
      summary: {
        rcb_funding_available: '500',
        rcb_locked: '1000',
        svip_level_code: 'SVIP1',
      },
    });
    await expect(
      createRcbLock({amount: '1000', lockPeriodDays: 365}),
    ).resolves.toMatchObject({lock: {id: 9}, rcbFundingAvailable: '500'});
    expect(post).toHaveBeenCalledWith(
      '/vip/lock-rcb',
      {amount: '1000', lock_period_days: 365},
      {retry: 'none'},
    );
  });

  it('reconciles matured RCB locks through an idempotent POST response', async () => {
    const post = jest.spyOn(apiClient, 'post').mockResolvedValue({
      released_count: 1,
      released_amount: '25.000000000000000000',
      lock_ids: [17],
    });
    await expect(releaseMaturedRcbLocks()).resolves.toEqual({
      releasedCount: 1,
      releasedAmount: '25.000000000000000000',
      lockIds: [17],
    });
    expect(post).toHaveBeenCalledWith(
      '/vip/rcb-locks/release-matured',
      undefined,
      {retry: 'none'},
    );
  });

  it('derives the displayed SVIP target from current plus requested lock amount', () => {
    const overview = {
      effectiveLevelCode: 'VIP0',
      effectiveFeeSource: 'VIP',
      effectiveSpotMakerFee: '0.001',
      effectiveSpotTakerFee: '0.001',
      volume30d: '0',
      rcbAvailable: '5000',
      rcbFundingAvailable: '5000',
      rcbLocked: '600',
      rcbLockPeriodDays: 0,
      rcbFeePayPercent: '80',
      vipLevels: [],
      svipLevels: [
        {
          levelCode: 'SVIP1',
          levelName: 'SVIP 1',
          sortOrder: 1,
          spotMakerFee: '0.001',
          spotTakerFee: '0.001',
          min30dVolume: null,
          minRcbHold: null,
          minLockAmount: '1000',
          lockPeriodDays: 365,
          dividendRate: '0.05',
        },
      ],
    };
    expect(pickTargetLevel(overview, 400)?.levelCode).toBe('SVIP1');
    expect(pickTargetLevel(overview, 399)).toBeNull();
  });
});
