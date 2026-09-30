import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import Header from './Header';

const mockPush = jest.fn();
const mockPrefetch = jest.fn();
const mockRouter = { push: mockPush, prefetch: mockPrefetch };
let mockPathname = '/notice';
let mockSearchKey = '';
let mockBankPortalUrl: string | null = null;

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
  useSearchParams: () => ({ toString: () => mockSearchKey }),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

jest.mock('@/lib/authContext', () => ({
  useAuth: () => ({ isLoggedIn: false }),
}));

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    t: (key: string) => ({
      search: 'Search',
      closeSearch: 'Close search',
      searchPlaceholder: 'Search markets',
      navBankPortal: 'Bank',
    }[key] || key),
  }),
}));

jest.mock('@/lib/api/modules/site', () => ({
  fallbackSiteConfig: {
    logo_url: '/icons/app-logo-256.png',
    site_name: 'Exchange',
    site_slogan: '',
  },
  getSiteConfig: () => Promise.resolve({ site_name: 'Exchange', bank_portal_url: mockBankPortalUrl }),
}));

jest.mock('@/lib/api/modules/announcements', () => ({
  getAnnouncementUnreadCount: () => new Promise(() => undefined),
}));

jest.mock('@/utils/language', () => ({
  DEFAULT_LANGUAGE: 'en',
  getCurrentLanguage: () => 'en',
  setCurrentLanguage: jest.fn(),
}));

jest.mock('./MegaMenu', () => () => null);
jest.mock('./MobileMenu', () => () => null);

describe('Header market search interaction', () => {
  beforeEach(() => {
    mockPathname = '/notice';
    mockSearchKey = '';
    mockBankPortalUrl = null;
    mockPush.mockReset();
    mockPrefetch.mockReset();
  });

  test('opens and closes the search component from the header button', async () => {
    render(<Header />);
    await screen.findByRole('link', { name: 'navHelpCenter' });

    const searchButton = screen.getByRole('button', { name: 'Search' });
    fireEvent.click(searchButton);

    expect(searchButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.click(searchButton);
    expect(searchButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  test('closes an open search only after the route actually changes', async () => {
    const view = render(<Header />);
    const searchButton = screen.getByRole('button', { name: 'Search' });

    fireEvent.click(searchButton);
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    view.rerender(<Header />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    mockPathname = '/markets';
    view.rerender(<Header />);

    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument());
  });

  test('shows the configured portal after Help Center as an external link', async () => {
    mockBankPortalUrl = 'https://bank.example.com/portal';
    render(<Header />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Bank' })).toHaveAttribute('href', mockBankPortalUrl));
    const link = screen.getByRole('link', { name: 'Bank' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(mockPrefetch).not.toHaveBeenCalledWith(mockBankPortalUrl);
  });

  test('opens the coming-soon page when no bank destination is configured', async () => {
    render(<Header />);
    const link = await screen.findByRole('link', { name: 'Bank' });
    expect(link).toHaveAttribute('href', '/bank');
    expect(link).not.toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button', { name: 'Bank' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
