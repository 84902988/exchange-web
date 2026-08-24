import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import ContractOrderBook from '../src/components/contract/ContractOrderBook';
import TradeOrderBook from '../src/components/trade/TradeOrderBook';

const levels = Array.from({length: 7}, (_, index) => ({
  price: 63_400 + index / 10,
  amount: index + 1,
}));

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node =>
      typeof node.props.children === 'string' ? [node.props.children] : [],
    );
}

describe('mobile order-book presentation', () => {
  it('keeps the spot middle row price-only', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeOrderBook
          amountPrecision={6}
          asks={levels}
          baseAsset="BTC"
          bids={levels}
          lastPrice={63_405}
          onPricePress={jest.fn()}
          pricePrecision={1}
          quoteAsset="USDT"
          trades={[]}
        />,
      );
    });

    expect(renderedText(renderer)).not.toContain('最新价');
    expect(renderedText(renderer)).toContain('63,405.0');
    expect(renderedText(renderer)).toContain('63,400.0');
  });

  it('shows small positive spot quantities at the market amount precision', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeOrderBook
          amountPrecision={6}
          asks={[{price: 63_405.2, amount: 0.000015}]}
          baseAsset="BTC"
          bids={[]}
          lastPrice={63_405}
          onPricePress={jest.fn()}
          pricePrecision={1}
          quoteAsset="USDT"
          trades={[]}
        />,
      );
    });

    expect(renderedText(renderer)).toContain('0.000015');
  });

  it('keeps the contract middle row price-only without duplicating mark price', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderBook
          asks={levels}
          baseAsset="BTC"
          bids={levels}
          lastPrice={63_405}
          markPrice={63_404.9}
          onPricePress={jest.fn()}
          pricePrecision={1}
          quoteAsset="USDT"
          trades={[]}
        />,
      );
    });

    expect(renderedText(renderer).join(' ')).not.toContain('标记价');
    expect(renderedText(renderer)).toContain('63,405.0');
    expect(renderedText(renderer)).toContain('63,400.0');
  });

  it('keeps the last complete contract depth during a transient partial frame', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderBook
          asks={levels}
          baseAsset="BTC"
          bids={levels}
          lastPrice={63_405}
          markPrice={63_404.9}
          onPricePress={jest.fn()}
          pricePrecision={1}
          quoteAsset="USDT"
          trades={[]}
        />,
      );
    });

    act(() => {
      renderer.update(
        <ContractOrderBook
          asks={levels}
          baseAsset="BTC"
          bids={levels.slice(0, 5)}
          lastPrice={63_405}
          markPrice={63_404.9}
          onPricePress={jest.fn()}
          pricePrecision={1}
          quoteAsset="USDT"
          trades={[]}
        />,
      );
    });

    expect(renderedText(renderer)).not.toContain('--');
    expect(renderedText(renderer)).toContain('63,400.6');
  });
});
