import React from 'react';
import {StyleSheet, Text} from 'react-native';
import Renderer, {act} from 'react-test-renderer';
import * as assets from '../src/api/assets';
import {LanguageProvider} from '../src/i18n';
import AssetHistoryScreen from '../src/screens/assets/AssetHistoryScreen';
import {colors} from '../src/theme';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({goBack: jest.fn(), navigate: jest.fn()}),
  useRoute: () => ({params: {}}),
}));
jest.mock('../src/store/authStore', () => ({useAuth: () => ({isLoggedIn: true})}));

test('signed API amounts render withdrawal principal and fee red, while returns and deposits stay green', async () => {
  const response = assets.normalizeAssetBalanceLogsResponse({
    items: [
      ['WITHDRAW_SUCCESS', '-0.1'], ['WITHDRAW_FEE_SUCCESS', '-0.005'],
      ['WITHDRAW_CANCEL', '0.2'], ['DEPOSIT', '0.3'],
    ].map(([biz_type, change_amount], index) => ({
      id: index + 1, biz_type, change_amount, coin_symbol: 'USDT', chain_key: 'funding',
      after_available: '6.26', created_at: '2026-09-19 08:34:07',
    })), page: 1, page_size: 20, total: 4,
  });
  const fetch = jest.spyOn(assets, 'fetchAssetBalanceLogs').mockResolvedValue(response);
  let renderer: Renderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = Renderer.create(<LanguageProvider><AssetHistoryScreen /></LanguageProvider>); });
    for (const [amount, color] of [['-0.1', colors.red], ['-0.005', colors.red], ['+0.2', colors.green], ['+0.3', colors.green]]) {
      const label = renderer!.root.findAllByType(Text).find(node =>
        React.Children.toArray(node.props.children).join('') === `${amount} USDT`,
      );
      expect(label).toBeDefined();
      expect(StyleSheet.flatten(label!.props.style).color).toBe(color);
    }
  } finally {
    act(() => renderer?.unmount());
    fetch.mockRestore();
  }
});
