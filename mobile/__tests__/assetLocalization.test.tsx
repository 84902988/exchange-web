import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AssetOverviewCard from '../src/components/assets/AssetOverviewCard';
import AssetTopTabs from '../src/components/assets/AssetTopTabs';
import AssetInviteCommissionRecords from '../src/components/assets/AssetInviteCommissionRecords';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
} from '../src/i18n';

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

describe('asset read-only UI localization', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  });

  it('renders asset tabs, valuation state and referral statuses in English', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <>
            <AssetTopTabs activeKey="overview" onChange={jest.fn()} />
            <AssetOverviewCard
              fetchedAt={1_000}
              hidden={false}
              isLoggedIn
              snapshotAvailable
              totalUsdt={42}
              valuationComplete
              onToggleHidden={jest.fn()}
            />
            <AssetInviteCommissionRecords
              items={[
                {
                  id: 1,
                  inviteeUserId: 7,
                  feeAmount: '2',
                  feeCoinSymbol: 'USDT',
                  feeUsdtValue: '2',
                  commissionRate: '15',
                  commissionRcbAmount: '0.3',
                  status: 'PAID',
                  createdAt: '2026-08-05T00:00:00Z',
                  paidAt: '2026-08-05T00:05:00Z',
                },
              ]}
            />
          </>
        </LanguageProvider>,
      );
    });

    const text = renderedText(renderer);
    expect(text).toContain('Overview');
    expect(text).toContain('Total asset valuation');
    expect(text).toContain('Valuation complete');
    expect(text).toContain('Recent reward records');
    expect(text).toContain('Paid');
    expect(text).not.toContain('账户分布');
    act(() => renderer.unmount());
  });
});
