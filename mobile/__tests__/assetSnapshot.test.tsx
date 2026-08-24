import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import {
  normalizeAssetAccountBalances,
  type AssetAccountBalance,
} from '../src/api/assets';
import {
  buildAssetTickerBatchPath,
  calculateAssetSnapshot,
  createAssetSnapshotRepository,
  getAssetAccountValuation,
  normalizeAssetSnapshotUserId,
  normalizeAssetTickerPrices,
  type AssetSnapshot,
} from '../src/services/assetSnapshot';
import AssetSummary from '../src/components/home/AssetSummary';
import PrimaryButton from '../src/components/common/PrimaryButton';
import AssetCoinList from '../src/components/assets/AssetCoinList';
import { getAssetDistributionSegments } from '../src/components/assets/AssetAccountDistribution';
import AssetOverviewCard from '../src/components/assets/AssetOverviewCard';
import {
  GuestAssetTabCard,
  OverviewContent,
  getGuestAssetTabCopy,
} from '../src/screens/assets/AssetsScreen';

const mockNavigate = jest.fn();
let mockAssetSnapshotState: {
  userId: string | null;
  snapshot: AssetSnapshot | null;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
} = {
  userId: null,
  snapshot: null,
  loading: false,
  refreshing: false,
  stale: false,
  error: null,
};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('../src/hooks/useAssetSnapshot', () => ({
  useAssetSnapshot: () => mockAssetSnapshotState,
}));

function balance(
  symbol: string,
  accountKey: string,
  available: number | null,
  frozen: number | null = 0,
): AssetAccountBalance {
  return { symbol, accountKey, available, frozen };
}

describe('asset valuation', () => {
  it('normalizes numeric identities without accepting a zero user', () => {
    expect(normalizeAssetSnapshotUserId(7)).toBe('7');
    expect(normalizeAssetSnapshotUserId('0007')).toBe('7');
    expect(normalizeAssetSnapshotUserId('user-a')).toBe('user-a');
    expect(normalizeAssetSnapshotUserId('0')).toBe('');
  });

  it('uses the backend batch ticker query contract', () => {
    expect(buildAssetTickerBatchPath(['BTCUSDT', 'ETHUSDT'])).toBe(
      '/market/tickers?symbols=BTCUSDT%2CETHUSDT',
    );
  });

  it('marks the total incomplete when a positive non-USDT balance has no price', () => {
    const snapshot = calculateAssetSnapshot({
      userId: 7,
      balances: [balance('USDT', 'funding', 10), balance('BTC', 'spot', 2)],
      pricesUsdt: {},
      fetchedAt: 100,
    });

    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdt).toBeNull();
    expect(snapshot.knownTotalUsdt).toBe(10);
    expect(snapshot.missingPriceSymbols).toEqual(['BTC']);
    expect(snapshot.rows.find(row => row.symbol === 'BTC')).toMatchObject({
      valueUsdt: null,
      valuationComplete: false,
    });
  });

  it('aggregates duplicate coin rows within an account and values each account once', () => {
    const snapshot = calculateAssetSnapshot({
      userId: 'user-1',
      balances: [
        balance('BTC', 'funding', 1),
        balance('btc', 'funding', 2),
        balance('BTC', 'spot', 3),
        balance('USDT', 'contract', 25, 5),
      ],
      pricesUsdt: { BTC: 100 },
      fetchedAt: 200,
    });

    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.totalUsdt).toBe(630);
    expect(snapshot.rows.find(row => row.key === 'funding:BTC')).toMatchObject({
      available: 3,
      totalAmount: 3,
      valueUsdt: 300,
    });
    expect(getAssetAccountValuation(snapshot, 'funding')).toMatchObject({
      totalUsdt: 300,
      positiveAssetCount: 1,
      valuationComplete: true,
    });
    expect(getAssetAccountValuation(snapshot, 'spot').totalUsdt).toBe(300);
    expect(getAssetAccountValuation(snapshot, 'contract').totalUsdt).toBe(30);
  });

  it('does not coerce an unknown amount into zero', () => {
    const snapshot = calculateAssetSnapshot({
      userId: 8,
      balances: [balance('USDT', 'funding', null, 1)],
      pricesUsdt: {},
      fetchedAt: 300,
    });

    expect(snapshot.valuationComplete).toBe(false);
    expect(snapshot.totalUsdt).toBeNull();
    expect(snapshot.rows[0]).toMatchObject({
      totalAmount: null,
      valueUsdt: null,
      valuationComplete: false,
    });
  });

  it('accepts only one exact, positive, explicitly non-stale ticker per symbol', () => {
    const prices = normalizeAssetTickerPrices(
      [
        { symbol: 'BTCUSDT', last_price: '100', stale: false },
        { symbol: 'ETHUSDT', last_price: '200', stale: true },
        { symbol: 'SOLUSD', last_price: '50', stale: false },
        { symbol: 'ADAUSDT', last_price: '1', stale: false },
        { symbol: 'ADAUSDT', last_price: '1.1', stale: false },
        { symbol: 'XRPUSDT', last_price: '0', stale: false },
        { symbol: 'DOGEUSDT', last_price: '0.1' },
      ],
      ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE'],
    );

    expect(prices).toEqual({ BTC: 100 });
  });
});

describe('asset balance transport normalization', () => {
  it('preserves valid zero amounts and rejects null or missing required fields', () => {
    expect(
      normalizeAssetAccountBalances([
        {
          symbol: 'USDT',
          account_key: 'funding',
          available: '0',
          frozen: '1.5',
        },
      ]),
    ).toEqual([
      {
        symbol: 'USDT',
        accountKey: 'funding',
        available: 0,
        frozen: 1.5,
        availableText: '0',
        frozenText: '1.5',
      },
    ]);

    expect(() =>
      normalizeAssetAccountBalances([
        {
          symbol: 'USDT',
          account_key: 'funding',
          available: null,
          frozen: '0',
        },
      ]),
    ).toThrow('可用余额缺失');

    expect(
      normalizeAssetAccountBalances([
        {
          symbol: 'USDT',
          account_key: 'funding',
          available: '9007199254740992.123456789012345678',
          frozen: '0.000000000000000001',
        },
      ])[0],
    ).toMatchObject({
      availableText: '9007199254740992.123456789012345678',
      frozenText: '0.000000000000000001',
    });
  });
});

describe('asset snapshot repository', () => {
  it('uses one batch ticker request for all non-USDT assets and fixes USDT at 1', async () => {
    const fetchTickerPayload = jest.fn().mockResolvedValue([
      { symbol: 'BTCUSDT', last_price: '100', stale: false },
      { symbol: 'ETHUSDT', last_price: '20', stale: false },
    ]);
    const repository = createAssetSnapshotRepository({
      fetchBalances: jest
        .fn()
        .mockResolvedValue([
          balance('USDT', 'funding', 5),
          balance('ETH', 'spot', 2),
          balance('BTC', 'funding', 1),
        ]),
      fetchTickerPayload,
      now: () => 1_000,
    });

    const result = await repository.load({ userId: 1 });

    expect(fetchTickerPayload).toHaveBeenCalledTimes(1);
    expect(fetchTickerPayload).toHaveBeenCalledWith(['BTCUSDT', 'ETHUSDT']);
    expect(result.snapshot?.totalUsdt).toBe(145);
    expect(
      result.snapshot?.rows.find(row => row.symbol === 'USDT')?.priceUsdt,
    ).toBe(1);
  });

  it('does not request tickers for an all-USDT snapshot', async () => {
    const fetchTickerPayload = jest.fn();
    const repository = createAssetSnapshotRepository({
      fetchBalances: jest
        .fn()
        .mockResolvedValue([balance('USDT', 'funding', 9)]),
      fetchTickerPayload,
    });

    const result = await repository.load({ userId: 1 });

    expect(result.snapshot?.totalUsdt).toBe(9);
    expect(fetchTickerPayload).not.toHaveBeenCalled();
  });

  it('single-flights concurrent loads for the same user and honors TTL', async () => {
    let now = 1_000;
    let release!: (balances: AssetAccountBalance[]) => void;
    const gate = new Promise<AssetAccountBalance[]>(resolve => {
      release = resolve;
    });
    const fetchBalances = jest.fn().mockReturnValue(gate);
    const repository = createAssetSnapshotRepository({
      fetchBalances,
      now: () => now,
      ttlMs: 100,
    });

    const first = repository.load({ userId: 1 });
    const second = repository.load({ userId: 1 });
    expect(first).toBe(second);
    expect(fetchBalances).toHaveBeenCalledTimes(1);

    release([balance('USDT', 'funding', 10)]);
    await Promise.all([first, second]);
    await repository.load({ userId: 1 });
    expect(fetchBalances).toHaveBeenCalledTimes(1);

    now += 101;
    fetchBalances.mockResolvedValueOnce([balance('USDT', 'funding', 11)]);
    const refreshed = await repository.load({ userId: 1 });
    expect(refreshed.snapshot?.totalUsdt).toBe(11);
    expect(fetchBalances).toHaveBeenCalledTimes(2);
  });

  it('isolates slow responses and caches by immutable user id', async () => {
    const releases = new Map<
      string,
      (balances: AssetAccountBalance[]) => void
    >();
    const fetchBalances = jest.fn(
      (userId: string) =>
        new Promise<AssetAccountBalance[]>(resolve => {
          releases.set(userId, resolve);
        }),
    );
    const repository = createAssetSnapshotRepository({ fetchBalances });

    const userA = repository.load({ userId: 'user-a' });
    const userB = repository.load({ userId: 'user-b' });
    releases.get('user-b')?.([balance('USDT', 'funding', 22)]);
    const resultB = await userB;
    releases.get('user-a')?.([balance('USDT', 'funding', 11)]);
    const resultA = await userA;

    expect(resultA.snapshot?.userId).toBe('user-a');
    expect(resultA.snapshot?.totalUsdt).toBe(11);
    expect(resultB.snapshot?.userId).toBe('user-b');
    expect(resultB.snapshot?.totalUsdt).toBe(22);
    expect(repository.peek('user-a')?.totalUsdt).toBe(11);
    expect(repository.peek('user-b')?.totalUsdt).toBe(22);
  });

  it('keeps only the same user last-success snapshot on refresh failure', async () => {
    let now = 5_000;
    const fetchBalances = jest
      .fn()
      .mockResolvedValueOnce([balance('USDT', 'funding', 12)])
      .mockRejectedValue(new Error('offline'));
    const repository = createAssetSnapshotRepository({
      fetchBalances,
      now: () => now,
      ttlMs: 100,
    });

    const success = await repository.load({ userId: 'user-a' });
    now += 101;
    const stale = await repository.load({ userId: 'user-a' });
    const otherUser = await repository.load({ userId: 'user-b' });

    expect(stale.source).toBe('stale-cache');
    expect(stale.snapshot).toBe(success.snapshot);
    expect(stale.error).toBeTruthy();
    expect(otherUser.source).toBe('error');
    expect(otherUser.snapshot).toBeNull();
  });

  it('keeps the last snapshot when the ticker batch shape is invalid', async () => {
    const fetchTickerPayload = jest
      .fn()
      .mockResolvedValueOnce([
        { symbol: 'BTCUSDT', last_price: '100', stale: false },
      ])
      .mockResolvedValueOnce({ items: [] });
    const repository = createAssetSnapshotRepository({
      fetchBalances: jest.fn().mockResolvedValue([balance('BTC', 'spot', 1)]),
      fetchTickerPayload,
    });

    const success = await repository.load({ userId: 1 });
    const stale = await repository.load({ userId: 1, force: true });

    expect(success.snapshot?.totalUsdt).toBe(100);
    expect(stale.source).toBe('stale-cache');
    expect(stale.snapshot).toBe(success.snapshot);
  });

  it('bounds cached user snapshots so account switching cannot grow memory indefinitely', async () => {
    const repository = createAssetSnapshotRepository({
      fetchBalances: jest
        .fn()
        .mockResolvedValue([balance('USDT', 'funding', 1)]),
      now: () => 1_000,
    });

    for (let userId = 1; userId <= 5; userId += 1) {
      await repository.load({ userId });
    }

    expect(repository.peek(1)).toBeNull();
    expect(repository.peek(2)?.userId).toBe('2');
    expect(repository.peek(5)?.userId).toBe('5');
  });
});

describe('Home asset summary snapshot wiring', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockAssetSnapshotState = {
      userId: 'user-1',
      snapshot: null,
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
    };
  });

  it('renders the shared snapshot instead of a fixed value and opens real deposit', () => {
    mockAssetSnapshotState = {
      userId: 'user-1',
      snapshot: calculateAssetSnapshot({
        userId: 1,
        balances: [balance('USDT', 'funding', 42)],
        pricesUsdt: {},
        fetchedAt: 1_000,
      }),
      loading: false,
      refreshing: false,
      stale: false,
      error: null,
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AssetSummary />);
    });

    const renderedText = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(renderedText).toContain('42 USDT');
    expect(renderedText).not.toContain('5.22');

    act(() => {
      renderer!.root.findByType(PrimaryButton).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('AssetDeposit');
  });
});

describe('asset snapshot presentation', () => {
  it('gives every logged-out asset tab distinct, actionable content', () => {
    expect(getGuestAssetTabCopy('spot').title).toBe('查看真实现货余额');
    expect(getGuestAssetTabCopy('contract').title).toBe('查看保证金与盈亏');
    expect(getGuestAssetTabCopy('invite').title).toBe('查看邀请数据与奖励');
    expect(getGuestAssetTabCopy('bd').title).toBe('查看代理等级与佣金');

    const onLoginPress = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <GuestAssetTabCard activeTab="contract" onLoginPress={onLoginPress} />,
      );
    });
    expect(
      renderer!.root.findAllByType(Text).flatMap(node => node.props.children),
    ).toContain('查看保证金与盈亏');
    act(() => {
      renderer!.root
        .findByProps({ accessibilityLabel: '登录查看合约账户' })
        .props.onPress();
    });
    expect(onLoginPress).toHaveBeenCalledTimes(1);
  });

  it('draws only finite positive account distribution values at their real ratio', () => {
    const items = [
      { key: 'zero', label: 'Zero', value: 0, color: '#000000' },
      { key: 'negative', label: 'Negative', value: -2, color: '#111111' },
      { key: 'unknown', label: 'Unknown', value: null, color: '#222222' },
      { key: 'one', label: 'One', value: 1, color: '#333333' },
      { key: 'three', label: 'Three', value: 3, color: '#444444' },
    ];

    expect(getAssetDistributionSegments(items, true)).toEqual([
      items[3],
      items[4],
    ]);
    expect(getAssetDistributionSegments(items, false)).toEqual([]);
    expect(getAssetDistributionSegments(items.slice(0, 3), true)).toEqual([]);
  });

  it('shows unknown valuation as -- instead of a complete zero total', () => {
    const incomplete = calculateAssetSnapshot({
      userId: 1,
      balances: [balance('BTC', 'spot', 1)],
      pricesUsdt: {},
      fetchedAt: 1_000,
    });
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <>
          <AssetOverviewCard
            fetchedAt={incomplete.fetchedAt}
            hidden={false}
            isLoggedIn
            snapshotAvailable
            totalUsdt={incomplete.totalUsdt}
            valuationComplete={incomplete.valuationComplete}
            onToggleHidden={jest.fn()}
          />
          <AssetCoinList emptyTitle="暂无资产" items={incomplete.rows} />
        </>,
      );
    });

    const renderedText = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(renderedText).toContain('-- USDT');
    expect(renderedText).toContain('估值不可用');
    expect(renderedText).not.toContain('0 USDT');
    expect(renderedText).not.toContain('≈');
  });

  it('presents a neutral login state instead of an asset-data warning', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetOverviewCard
          fetchedAt={null}
          hidden={false}
          isLoggedIn={false}
          snapshotAvailable={false}
          totalUsdt={null}
          valuationComplete={false}
          onToggleHidden={jest.fn()}
        />,
      );
    });

    const renderedText = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(renderedText).toContain('登录后显示');
    expect(renderedText).toContain('尚未登录');
    expect(renderedText).not.toContain('暂无资产数据');
    expect(
      renderer!.root.findAllByProps({ accessibilityLabel: '隐藏资产' }),
    ).toHaveLength(0);
  });

  it('does not render unsupported security or reserve claims', () => {
    const snapshot = calculateAssetSnapshot({
      userId: 1,
      balances: [balance('RCB', 'funding', 10)],
      pricesUsdt: { RCB: 2 },
      fetchedAt: 1_000,
    });
    const accountValuations = {
      funding: getAssetAccountValuation(snapshot, 'funding'),
      spot: getAssetAccountValuation(snapshot, 'spot'),
      contract: getAssetAccountValuation(snapshot, 'contract'),
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OverviewContent
          accountValuations={accountValuations}
          distributionItems={[
            {
              key: 'funding',
              label: '资金账户',
              value: accountValuations.funding.totalUsdt,
              color: '#D6A832',
            },
          ]}
          hidden={false}
          valuationComplete
          valuationRows={snapshot.rows}
        />,
      );
    });

    const renderedText = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(renderedText).not.toContain('储备金证明');
    expect(renderedText).not.toContain('资金安全');
    expect(renderedText).toContain('RCB');
  });
});
