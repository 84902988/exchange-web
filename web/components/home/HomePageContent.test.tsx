import { act, render, screen, waitFor } from '@testing-library/react';

import HomePageContent from './HomePageContent';
import {
  fallbackSiteConfig,
  getHomeBanners,
  getLatestAnnouncements,
  getSiteConfig,
} from '@/lib/api/modules/site';

let mockLocaleInitialized = false;

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    locale: 'zh',
    isInitialized: mockLocaleInitialized,
    t: (key: string) => key,
  }),
}));

jest.mock('@/components/home/HomeHero', () => ({
  __esModule: true,
  default: ({ backgroundMediaSrc }: { backgroundMediaSrc?: string }) => (
    <div data-testid="home-hero" data-media-src={backgroundMediaSrc || ''} />
  ),
}));

jest.mock('@/components/home/PromoCards', () => ({
  __esModule: true,
  default: () => <div data-testid="promo-cards" />,
}));

jest.mock('@/components/home/HomeNotice', () => ({
  __esModule: true,
  default: () => <div data-testid="home-notice" />,
}));

jest.mock('@/lib/api/modules/site', () => {
  const actual = jest.requireActual('@/lib/api/modules/site');
  return {
    ...actual,
    getSiteConfig: jest.fn(),
    getHomeBanners: jest.fn(),
    getLatestAnnouncements: jest.fn(),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('HomePageContent loading order', () => {
  beforeEach(() => {
    mockLocaleInitialized = false;
    jest.clearAllMocks();
  });

  test('renders fallback media immediately and commits site config independently', async () => {
    const configResult = deferred<typeof fallbackSiteConfig>();
    const bannerResult = deferred<{ items: [] }>();
    const announcementResult = deferred<{ items: [] }>();
    jest.mocked(getSiteConfig).mockReturnValue(configResult.promise);
    jest.mocked(getHomeBanners).mockReturnValue(bannerResult.promise);
    jest.mocked(getLatestAnnouncements).mockReturnValue(announcementResult.promise);

    const view = render(<HomePageContent />);

    expect(screen.getByTestId('home-hero')).toHaveAttribute(
      'data-media-src',
      '/homepage-bg480.mp4',
    );
    expect(getSiteConfig).not.toHaveBeenCalled();

    mockLocaleInitialized = true;
    view.rerender(<HomePageContent />);
    await waitFor(() => expect(getSiteConfig).toHaveBeenCalledWith('zh'));

    await act(async () => {
      configResult.resolve({
        ...fallbackSiteConfig,
        home_hero_image: '/custom-home.mp4',
      });
      await configResult.promise;
    });

    expect(screen.getByTestId('home-hero')).toHaveAttribute(
      'data-media-src',
      '/custom-home.mp4',
    );

    await act(async () => {
      bannerResult.resolve({ items: [] });
      announcementResult.resolve({ items: [] });
      await Promise.all([bannerResult.promise, announcementResult.promise]);
    });
  });
});
