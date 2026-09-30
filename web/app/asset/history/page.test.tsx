import {render, screen} from '@testing-library/react';
import AssetsAPI from '@/lib/api/modules/assets';
import AssetHistoryPage from './page';

const mockTranslator = (key: string) => key;
jest.mock('@/contexts/LocaleContext', () => ({useLocaleContext: () => ({t: mockTranslator})}));
jest.mock('@/components/asset/AssetSidebar', () => ({__esModule: true, default: () => null}));
jest.mock('@/lib/api/modules/assets', () => ({__esModule: true, default: {getBalanceLogs: jest.fn()}}));

test('signed history API amounts render withdrawals in red and returned funds and deposits in green', async () => {
  jest.mocked(AssetsAPI.getBalanceLogs).mockResolvedValue({
    items: [
      ['WITHDRAW_SUCCESS', '-0.1'], ['WITHDRAW_FEE_SUCCESS', '-0.005'],
      ['WITHDRAW_CANCEL', '0.2'], ['DEPOSIT', '0.3'],
    ].map(([biz_type, change_amount], index) => ({
      id: index + 1, biz_type, change_amount, coin_symbol: 'USDT', chain_key: 'funding',
      after_available: '6.26', created_at: '2026-09-19 08:34:07',
    })), page: 1, page_size: 20, total: 4,
  });
  render(<AssetHistoryPage />);
  expect(await screen.findByText('-0.1')).toHaveClass('text-[#f6465d]');
  expect(screen.getByText('-0.005')).toHaveClass('text-[#f6465d]');
  expect(screen.getByText('+0.2')).toHaveClass('text-[#00c087]');
  expect(screen.getByText('+0.3')).toHaveClass('text-[#00c087]');
});
