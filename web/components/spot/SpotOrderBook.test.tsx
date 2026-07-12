import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import SpotOrderBook from './SpotOrderBook';

const translations: Record<string, string> = {
  spotOrderBook: '订单表',
  spotPrice: '价格',
  spotQuantity: '数量',
  spotTotal: '累计',
  spotLatestPrice: '最新价',
  spotLoadingOrderBook: '盘口加载中',
  spotNoOrderBookData: '暂无盘口',
};

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    locale: 'zh',
    t: (key: string) => translations[key] || key,
  }),
}), { virtual: true });

const asks = [
  { price: '101', amount: '1' },
  { price: '102', amount: '2' },
];
const bids = [
  { price: '99', amount: '1' },
  { price: '98', amount: '2' },
];

function renderOrderBook(overrides: Partial<React.ComponentProps<typeof SpotOrderBook>> = {}) {
  const props = {
    symbol: 'BTCUSDT',
    referencePrice: '100.00',
    pricePrecision: 2,
    asks,
    bids,
    ...overrides,
  };
  return {
    ...render(<SpotOrderBook {...props} />),
    props,
  };
}

describe('SpotOrderBook mode switch', () => {
  it('renders only the left-aligned mode toolbar in the internal header', () => {
    renderOrderBook();

    expect(screen.getByTestId('spot-orderbook-mode-toolbar')).toHaveClass(
      'justify-start',
      'min-h-6',
      'mb-1.5',
    );
    expect(screen.queryByText('订单表')).not.toBeInTheDocument();
    expect(screen.queryByText('BTC/USDT')).not.toBeInTheDocument();
  });

  it('defaults to ALL and renders asks, mid price, and bids', () => {
    renderOrderBook();

    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('101.00')).toBeInTheDocument();
    expect(screen.getByTestId('spot-orderbook-display-price')).toHaveTextContent('100.00');
    expect(screen.getByText('99.00')).toBeInTheDocument();
  });

  it('renders compact icon buttons with accessible labels, titles, and pressed state', () => {
    renderOrderBook();

    const allButton = screen.getByRole('button', { name: '全部' });
    const buyButton = screen.getByRole('button', { name: '买盘' });
    const sellButton = screen.getByRole('button', { name: '卖盘' });

    expect(allButton).toHaveAttribute('title', '全部');
    expect(buyButton).toHaveAttribute('title', '买盘');
    expect(sellButton).toHaveAttribute('title', '卖盘');
    expect(allButton).toHaveAttribute('aria-pressed', 'true');
    expect(buyButton).toHaveAttribute('aria-pressed', 'false');
    expect(sellButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('spot-orderbook-mode-icon-ALL')).toBeInTheDocument();
    expect(screen.getByTestId('spot-orderbook-mode-icon-BUY_ONLY')).toBeInTheDocument();
    expect(screen.getByTestId('spot-orderbook-mode-icon-SELL_ONLY')).toBeInTheDocument();
    expect(allButton).toHaveClass('h-6', 'w-6', 'border-0', 'bg-transparent');
    expect(screen.getByTestId('spot-orderbook-mode-icon-ALL')).toHaveClass('h-4', 'w-4');
    expect(screen.getByTestId('spot-orderbook-mode-icon-ALL')).toHaveClass('opacity-100', 'brightness-125');
    expect(screen.getByTestId('spot-orderbook-mode-icon-BUY_ONLY')).toHaveClass('opacity-35');

    fireEvent.click(buyButton);
    expect(allButton).toHaveAttribute('aria-pressed', 'false');
    expect(buyButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('spot-orderbook-mode-icon-ALL')).toHaveClass('opacity-35');
    expect(screen.getByTestId('spot-orderbook-mode-icon-BUY_ONLY')).toHaveClass('opacity-100', 'brightness-125');
  });

  it('renders only mid price and bids in BUY_ONLY mode', () => {
    renderOrderBook();

    fireEvent.click(screen.getByRole('button', { name: '买盘' }));

    expect(screen.getByRole('button', { name: '买盘' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('101.00')).not.toBeInTheDocument();
    expect(screen.getByTestId('spot-orderbook-display-price')).toBeInTheDocument();
    expect(screen.getByText('99.00')).toBeInTheDocument();
  });

  it('renders only asks and mid price in SELL_ONLY mode', () => {
    renderOrderBook();

    fireEvent.click(screen.getByRole('button', { name: '卖盘' }));

    expect(screen.getByRole('button', { name: '卖盘' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('101.00')).toBeInTheDocument();
    expect(screen.getByTestId('spot-orderbook-display-price')).toBeInTheDocument();
    expect(screen.queryByText('99.00')).not.toBeInTheDocument();
  });

  it('preserves row and mid-price click callbacks after switching modes', () => {
    const onPriceClick = jest.fn();
    renderOrderBook({ onPriceClick });
    fireEvent.click(screen.getByRole('button', { name: '买盘' }));

    fireEvent.click(screen.getByText('99.00'));
    fireEvent.click(screen.getByTestId('spot-orderbook-display-price'));

    expect(onPriceClick).toHaveBeenNthCalledWith(1, '99');
    expect(onPriceClick).toHaveBeenNthCalledWith(2, '100.00');
  });

  it('keeps the selected local mode when the symbol changes', () => {
    const { rerender, props } = renderOrderBook();
    fireEvent.click(screen.getByRole('button', { name: '卖盘' }));

    rerender(<SpotOrderBook {...props} symbol="ETHUSDT" />);

    expect(screen.getByRole('button', { name: '卖盘' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('ETH/USDT')).not.toBeInTheDocument();
    expect(screen.getByText('101.00')).toBeInTheDocument();
    expect(screen.queryByText('99.00')).not.toBeInTheDocument();
  });
});

describe('SpotOrderBook depth ratio', () => {
  it('calculates the ratio from valid amounts in the fixed full-book range', () => {
    renderOrderBook({
      bids: [
        { price: '99', amount: '3' },
        { price: '98', amount: 'invalid' },
        { price: '97', amount: '-1' },
      ],
      asks: [{ price: '101', amount: '7' }],
    });

    expect(screen.getByTestId('spot-orderbook-buy-ratio-label')).toHaveTextContent('B');
    expect(screen.getByTestId('spot-orderbook-buy-ratio')).toHaveTextContent('30.00%');
    expect(screen.getByTestId('spot-orderbook-sell-ratio')).toHaveTextContent('70.00%');
    expect(screen.getByTestId('spot-orderbook-sell-ratio-label')).toHaveTextContent('S');
    expect(screen.getByTestId('spot-orderbook-depth-ratio-bar')).toHaveClass('h-6');
    expect(screen.getByTestId('spot-orderbook-buy-ratio-bar')).toHaveStyle({
      width: '30%',
      backgroundColor: 'rgba(0, 192, 135, 0.10)',
    });
    expect(screen.getByTestId('spot-orderbook-sell-ratio-bar')).toHaveStyle({
      width: '70%',
      backgroundColor: 'rgba(246, 70, 93, 0.11)',
    });
  });

  it('supports a one-sided book without inventing a balanced ratio', () => {
    renderOrderBook({ asks: [] });

    expect(screen.getByTestId('spot-orderbook-buy-ratio')).toHaveTextContent('100.00%');
    expect(screen.getByTestId('spot-orderbook-sell-ratio')).toHaveTextContent('0.00%');
  });

  it('shows unavailable placeholders for an empty book', () => {
    renderOrderBook({ asks: [], bids: [] });

    expect(screen.getByTestId('spot-orderbook-buy-ratio')).toHaveTextContent('--');
    expect(screen.getByTestId('spot-orderbook-sell-ratio')).toHaveTextContent('--');
  });

  it.each([
    { depthFreshness: 'STALE' },
    { depthSource: 'MISSING' },
  ])('does not publish a ratio for stale or missing depth: %o', (depthState) => {
    renderOrderBook(depthState);

    expect(screen.getByTestId('spot-orderbook-buy-ratio')).toHaveTextContent('--');
    expect(screen.getByTestId('spot-orderbook-sell-ratio')).toHaveTextContent('--');
  });

  it('keeps the same full-book ratio in BUY_ONLY and SELL_ONLY modes', () => {
    renderOrderBook({
      bids: [{ price: '99', amount: '2' }],
      asks: [{ price: '101', amount: '8' }],
    });
    const buyRatio = screen.getByTestId('spot-orderbook-buy-ratio');
    const sellRatio = screen.getByTestId('spot-orderbook-sell-ratio');

    expect(buyRatio).toHaveTextContent('20.00%');
    expect(sellRatio).toHaveTextContent('80.00%');
    fireEvent.click(screen.getByRole('button', { name: '买盘' }));
    expect(buyRatio).toHaveTextContent('20.00%');
    expect(sellRatio).toHaveTextContent('80.00%');
    fireEvent.click(screen.getByRole('button', { name: '卖盘' }));
    expect(buyRatio).toHaveTextContent('20.00%');
    expect(sellRatio).toHaveTextContent('80.00%');
  });

  it('recalculates for the new symbol without resetting the selected mode', () => {
    const { rerender, props } = renderOrderBook({
      bids: [{ price: '99', amount: '2' }],
      asks: [{ price: '101', amount: '8' }],
    });
    fireEvent.click(screen.getByRole('button', { name: '买盘' }));

    rerender(
      <SpotOrderBook
        {...props}
        symbol="ETHUSDT"
        bids={[{ price: '49', amount: '6' }]}
        asks={[{ price: '51', amount: '4' }]}
      />,
    );

    expect(screen.getByRole('button', { name: '买盘' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('spot-orderbook-buy-ratio')).toHaveTextContent('60.00%');
    expect(screen.getByTestId('spot-orderbook-sell-ratio')).toHaveTextContent('40.00%');
  });
});

describe('SpotOrderBook trade direction arrow', () => {
  it('shows an up arrow from an eligible real-trade direction', () => {
    renderOrderBook({ tradeDirection: 'up', hasTradeDirection: true });

    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↑');
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveClass(
      'text-[#00c087]',
      'text-[15px]',
      'font-black',
    );
  });

  it('shows a down arrow from an eligible real-trade direction', () => {
    renderOrderBook({ tradeDirection: 'down', hasTradeDirection: true });

    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↓');
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveClass('text-[#f6465d]');
  });

  it('does not show an arrow for a flat trade direction', () => {
    renderOrderBook({ tradeDirection: 'flat', hasTradeDirection: true });

    expect(screen.queryByTestId('spot-orderbook-price-direction')).not.toBeInTheDocument();
  });

  it('does not show an arrow without sufficient real-trade evidence', () => {
    renderOrderBook({ tradeDirection: 'up', hasTradeDirection: false });

    expect(screen.queryByTestId('spot-orderbook-price-direction')).not.toBeInTheDocument();
  });

  it('clears the old arrow when the symbol changes without eligible trade direction', () => {
    const { rerender, props } = renderOrderBook({
      tradeDirection: 'up',
      hasTradeDirection: true,
    });
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↑');

    rerender(
      <SpotOrderBook
        {...props}
        symbol="ETHUSDT"
        tradeDirection="flat"
        hasTradeDirection={false}
      />,
    );

    expect(screen.queryByTestId('spot-orderbook-price-direction')).not.toBeInTheDocument();
  });

  it('keeps the arrow visible across all orderbook display modes', () => {
    renderOrderBook({ tradeDirection: 'down', hasTradeDirection: true });

    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↓');
    fireEvent.click(screen.getByRole('button', { name: '买盘' }));
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↓');
    fireEvent.click(screen.getByRole('button', { name: '卖盘' }));
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↓');
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(screen.getByTestId('spot-orderbook-price-direction')).toHaveTextContent('↓');
  });
});
