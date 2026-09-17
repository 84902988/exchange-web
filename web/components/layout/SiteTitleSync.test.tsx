import { act, render, waitFor } from '@testing-library/react';
import { getSiteConfig } from '@/lib/api/modules/site';
import SiteTitleSync from './SiteTitleSync';

let mockPathname = '/';
let mockLocale = 'en';
jest.mock('next/navigation', () => ({ usePathname: () => mockPathname }));
jest.mock('@/contexts/LocaleContext', () => ({ useLocaleContext: () => ({ locale: mockLocale }) }));
jest.mock('@/lib/api/modules/site', () => ({
  fallbackSiteConfig: { site_name: 'Exchange' },
  getSiteConfig: jest.fn(),
}));

const fetchConfig = jest.mocked(getSiteConfig);

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/';
  mockLocale = 'en';
  document.title = 'Exchange';
});

it('continues to use the configured title on ordinary pages', async () => {
  fetchConfig.mockResolvedValue({ site_name: 'Configured exchange' });
  render(<SiteTitleSync />);
  await waitFor(() => expect(document.title).toBe('Configured exchange'));
});

it('does not overwrite the download title when an earlier config request resolves', async () => {
  let resolveConfig!: (config: { site_name: string }) => void;
  fetchConfig.mockImplementation(() => new Promise((resolve) => { resolveConfig = resolve; }));
  const { rerender } = render(<SiteTitleSync />);
  mockPathname = '/download';
  rerender(<SiteTitleSync />);
  document.title = 'Download Exchange App';
  await act(async () => resolveConfig({ site_name: 'Configured exchange' }));
  expect(document.title).toBe('Download Exchange App');

  mockLocale = 'ja';
  document.title = 'Exchange アプリをダウンロード';
  rerender(<SiteTitleSync />);
  expect(fetchConfig).toHaveBeenCalledTimes(1);
  expect(document.title).toBe('Exchange アプリをダウンロード');
});
