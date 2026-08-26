import React from 'react';
import Svg from 'react-native-svg';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {defaultConfigForSelection} from '../src/components/chart/advancedChartConfig';
import MobileKlineChart, {
  buildPaneScale,
} from '../src/components/trade/MobileKlineChart';

const items = Array.from({length: 80}, (_, index) => ({
  openTime: 1_800_000_000_000 + index * 60_000,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 10 + index,
}));

describe('MobileKlineChart responsive canvas', () => {
  it('expands bounded indicator panes for values outside their normal range', () => {
    const scale = buildPaneScale({
      bottom: 200,
      fixedRange: [0, 100],
      guides: [20, 50, 80],
      histogram: [],
      lines: [
        {
          key: 'kdj-j',
          label: 'J',
          render: 'line',
          values: [-20, 120],
        },
      ],
      top: 100,
    });

    expect(scale.yForValue(120)).toBeGreaterThan(113);
    expect(scale.yForValue(120)).toBeLessThan(200);
    expect(scale.yForValue(-20)).toBeGreaterThan(113);
    expect(scale.yForValue(-20)).toBeLessThan(200);
  });

  it('uses the realtime current price for the right-edge display line', () => {
    const latestClose = items[items.length - 1].close;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MobileKlineChart
          currentPrice={222.34}
          height={220}
          interval="1m"
          items={items}
          pricePrecision={2}
          testID="responsive-kline"
        />,
      );
    });

    expect(
      renderer.root.findByProps({testID: 'kline-current-price-label-text'})
        .props.children,
    ).toBe('222.34');
    expect(items[items.length - 1].close).toBe(latestClose);
    act(() => renderer.unmount());
  });

  it('recomputes the SVG coordinate system from the measured layout width', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MobileKlineChart
          height={220}
          interval="1m"
          items={items}
          testID="responsive-kline"
          visibleCount={96}
        />,
      );
    });
    expect(renderer.root.findByType(Svg).props.viewBox).toBe('0 0 320 220');

    act(() => {
      renderer.root
        .findByProps({testID: 'responsive-kline-canvas'})
        .props.onLayout({nativeEvent: {layout: {width: 840}}});
    });
    expect(renderer.root.findByType(Svg).props.viewBox).toBe('0 0 840 220');
    act(() => renderer.unmount());
  });

  it('renders entry, take-profit and stop-loss price markers, including off-screen edges', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MobileKlineChart
          height={220}
          interval="1m"
          items={items}
          referencePriceLines={[
            {key: '7:ENTRY', kind: 'ENTRY', label: 'BUY 开仓均价', price: 80},
            {
              key: '7:TP',
              kind: 'TAKE_PROFIT',
              label: 'BUY 止盈价',
              price: 185,
            },
            {
              key: '7:SL',
              kind: 'STOP_LOSS',
              label: 'BUY 止损价',
              price: 150,
            },
          ]}
          testID="position-lines-kline"
        />,
      );
    });

    const renderedLineIds = new Set(
      renderer.root
        .findAll(
          node =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('kline-reference-line-7:'),
        )
        .map(node => node.props.testID),
    );
    expect(renderedLineIds).toEqual(
      new Set([
        'kline-reference-line-7:ENTRY',
        'kline-reference-line-7:TP',
        'kline-reference-line-7:SL',
      ]),
    );
    act(() => renderer.unmount());
  });

  it('separates labels for nearby position prices without moving their price lines', () => {
    const keys = ['8:ENTRY', '8:TP', '8:SL'];
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MobileKlineChart
          height={220}
          interval="1d"
          items={items}
          referencePriceLines={[
            {key: keys[0], kind: 'ENTRY', label: 'BUY 开仓均价', price: 178},
            {key: keys[1], kind: 'TAKE_PROFIT', label: 'BUY 止盈价', price: 177.9},
            {key: keys[2], kind: 'STOP_LOSS', label: 'BUY 止损价', price: 177.8},
          ]}
        />,
      );
    });

    const labelYs = keys
      .map(
        key =>
          renderer.root.findByProps({
            testID: `kline-reference-label-${key}`,
          }).props.y as number,
      )
      .sort((left, right) => left - right);
    expect(labelYs[1] - labelYs[0]).toBeGreaterThanOrEqual(14);
    expect(labelYs[2] - labelYs[1]).toBeGreaterThanOrEqual(14);

    const priceLineYs = keys.map(
      key =>
        renderer.root.findByProps({
          testID: `kline-reference-price-line-${key}`,
        }).props.y1 as number,
    );
    expect(Math.max(...priceLineYs) - Math.min(...priceLineYs)).toBeLessThan(3);
    act(() => renderer.unmount());
  });

  it('removes and restores the indicator pane without removing the overlay', () => {
    const indicatorConfig = defaultConfigForSelection({
      overlay: 'SUPER',
      pane: 'VOL',
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MobileKlineChart
          height={220}
          indicatorConfig={indicatorConfig}
          interval="1m"
          items={items}
          showPane={false}
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({testID: 'native-kline-indicator-pane'}),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node =>
          Array.isArray(node.props.children) &&
          typeof node.props.children[0] === 'string' &&
          node.props.children[0].startsWith('SUPER'),
      ),
    ).not.toHaveLength(0);

    act(() => {
      renderer.update(
        <MobileKlineChart
          height={220}
          indicatorConfig={indicatorConfig}
          interval="1m"
          items={items}
          showPane
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({testID: 'native-kline-indicator-pane'}),
    ).not.toHaveLength(0);
    act(() => renderer.unmount());
  });
});
