import React from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import ContractSymbolHeader from '../src/components/contract/ContractSymbolHeader';
import ContractTopTabs from '../src/components/contract/ContractTopTabs';
import AssetEmptyState from '../src/components/assets/AssetEmptyState';
import PrimaryButton from '../src/components/common/PrimaryButton';
import MarketCategoryTabs from '../src/components/markets/MarketCategoryTabs';
import MarketSearchBar from '../src/components/markets/MarketSearchBar';
import TradeTopTabs from '../src/components/trade/TradeTopTabs';
import TradeOrderForm from '../src/components/trade/TradeOrderForm';
import { SelectChips } from '../src/components/assets/action/ActionPrimitives';
import { colors } from '../src/theme';

function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer;
}

function flatStyle(node: ReactTestRenderer.ReactTestInstance) {
  const style =
    typeof node.props.style === 'function'
      ? node.props.style({ pressed: false })
      : node.props.style;
  return StyleSheet.flatten(style);
}

describe('primary navigation touch targets', () => {
  it.each([
    [
      'market category',
      <MarketCategoryTabs
        activeKey="overview"
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'crypto', label: '加密货币' },
        ]}
        onChange={jest.fn()}
      />,
      '总览',
    ],
    [
      'spot business',
      <TradeTopTabs
        activeKey="spot"
        tabs={[{ key: 'spot', label: '现货' }]}
        onChange={jest.fn()}
      />,
      '现货',
    ],
    [
      'contract business',
      <ContractTopTabs
        activeKey="perpetual"
        tabs={[{ key: 'perpetual', label: '合约' }]}
        onChange={jest.fn()}
      />,
      '合约',
    ],
  ])(
    '%s tab exposes selected state and a 44dp target',
    (_name, view, label) => {
      const renderer = render(view);
      const tab = renderer.root.find(
        node =>
          node.props.accessibilityRole === 'tab' &&
          node.findAll(child => child.props.children === label).length > 0,
      );

      expect(tab.props.accessibilityState).toMatchObject({ selected: true });
      expect(flatStyle(tab).height).toBeGreaterThanOrEqual(44);
      act(() => renderer.unmount());
    },
  );

  it('keeps the market search field inside a 44dp container', () => {
    const renderer = render(
      <MarketSearchBar value="" onChangeText={jest.fn()} />,
    );
    const input = renderer.root.findByType(TextInput);

    expect(input.props.accessibilityLabel).toBe('搜索市场');
    expect(input.parent).not.toBeNull();
    expect(flatStyle(input.parent!).height).toBeGreaterThanOrEqual(44);
    act(() => renderer.unmount());
  });

  it('uses a searchable picker for large asset and network catalogs', () => {
    const onChange = jest.fn();
    const renderer = render(
      <SelectChips
        label="币种"
        onChange={onChange}
        options={[
          { value: 'BTC', label: 'BTC Bitcoin' },
          { value: 'ETH', label: 'ETH Ethereum', meta: '1' },
        ]}
        searchable
        value="BTC"
      />,
    );

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: '币种，BTC Bitcoin' })
        .props.onPress();
    });
    const search = renderer.root
      .findAllByType(TextInput)
      .find(input => input.props.placeholder === '搜索币种或网络');
    expect(search).toBeDefined();
    act(() => search?.props.onChangeText('ethereum'));
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'ETH Ethereum，1' })
        .props.onPress();
    });

    expect(onChange).toHaveBeenCalledWith('ETH');
    act(() => renderer.unmount());
  });

  it('keeps inline option chips at 44dp with pressed feedback', () => {
    const renderer = render(
      <SelectChips
        label="筛选"
        onChange={jest.fn()}
        options={[{ value: 'all', label: '全部' }]}
        value="all"
      />,
    );
    const chip = renderer.root.findByProps({ accessibilityLabel: '全部' });

    expect(
      StyleSheet.flatten(chip.props.style({ pressed: false })).minHeight,
    ).toBeGreaterThanOrEqual(44);
    expect(
      StyleSheet.flatten(chip.props.style({ pressed: true })).transform,
    ).toEqual([{ scale: 0.985 }]);
    act(() => renderer.unmount());
  });

  it('keeps contract chart and more actions at 44dp', () => {
    const renderer = render(
      <ContractSymbolHeader
        baseAsset="BTC"
        changePercent={0}
        lastPrice={63000}
        markPrice={63000}
        pricePrecision={1}
        symbolLabel="BTC/USDT 永续"
        onOpenChart={jest.fn()}
        onOpenMore={jest.fn()}
        onSymbolPress={jest.fn()}
      />,
    );

    for (const label of ['打开合约K线', '更多合约功能']) {
      const button = renderer.root.findByProps({ accessibilityLabel: label });
      expect(flatStyle(button).width).toBeGreaterThanOrEqual(44);
      expect(flatStyle(button).height).toBeGreaterThanOrEqual(44);
    }
    expect(renderer.root.findAllByProps({ children: '63,000.0' })).toHaveLength(
      2,
    );
    act(() => renderer.unmount());
  });

  it('keeps a long contract runtime status inside one fixed-height header row', () => {
    const renderer = render(
      <ContractSymbolHeader
        baseAsset="BTC"
        changePercent={2.93}
        lastPrice={77317.5}
        markPrice={77317.5}
        marketStatus="行情展示 / 不可执行"
        pricePrecision={1}
        symbolLabel="BTC/USDT 永续"
        onOpenChart={jest.fn()}
        onOpenMore={jest.fn()}
        onSymbolPress={jest.fn()}
      />,
    );

    const header = renderer.root.findByProps({
      testID: 'contract-symbol-header',
    });
    const metaRow = renderer.root.findByProps({
      testID: 'contract-symbol-meta-row',
    });
    expect(flatStyle(header).height).toBe(56);
    expect(flatStyle(metaRow)).toMatchObject({
      height: 12,
      flexWrap: 'nowrap',
      overflow: 'hidden',
    });
    for (const textNode of metaRow.findAllByType(Text)) {
      expect(textNode.props.numberOfLines).toBe(1);
    }
    expect(
      metaRow.findAll(
        node =>
          typeof node.props.children === 'string' &&
          node.props.children.includes('资金费率'),
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('names the spot price and quantity inputs and exposes disabled state', () => {
    const renderer = render(
      <TradeOrderForm
        amount=""
        availableText="-- USDT"
        baseAsset="BTC"
        estimatedFeeLabel="预计手续费"
        estimatedFeeText="-- USDT"
        feedbackText=""
        feedbackTone={null}
        isLoggedIn={false}
        lastPrice={63000}
        orderType="MARKET"
        price=""
        quoteAsset="USDT"
        side="BUY"
        submitDisabled={false}
        submitting={false}
        onAmountChange={jest.fn()}
        onBboPress={jest.fn()}
        onLoginPress={jest.fn()}
        onOrderTypeChange={jest.fn()}
        onPercentPress={jest.fn()}
        onPriceChange={jest.fn()}
        onSideChange={jest.fn()}
        onSubmitPress={jest.fn()}
      />,
    );

    const price = renderer.root.findByProps({ accessibilityLabel: '价格' });
    const quantity = renderer.root.findByProps({ accessibilityLabel: '数量' });
    expect(price.props.accessibilityState).toEqual({ disabled: true });
    expect(quantity.props.accessibilityState).toEqual({ disabled: false });
    act(() => renderer.unmount());
  });

  it('uses dark text on brand-gold action surfaces', () => {
    const renderer = render(
      <>
        <PrimaryButton title="Primary action" />
        <AssetEmptyState
          actionLabel="Empty action"
          title="Empty"
          onActionPress={jest.fn()}
        />
      </>,
    );

    for (const label of ['Primary action', 'Empty action']) {
      const text = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === label);
      expect(text).toBeDefined();
      expect(StyleSheet.flatten(text?.props.style).color).toBe(colors.black);
    }
    act(() => renderer.unmount());
  });
});
