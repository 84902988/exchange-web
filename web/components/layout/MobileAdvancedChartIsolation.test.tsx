import { render, screen } from '@testing-library/react';

import Providers from '@/app/providers';
import AppChrome from './AppChrome';

let mockPathname = '/';

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('./Header', () => ({
  __esModule: true,
  default: () => <div data-testid="pc-header" />,
}));

jest.mock('./Footer', () => ({
  __esModule: true,
  default: () => <div data-testid="pc-footer" />,
}));

jest.mock('@/lib/authContext', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="private-auth-provider">{children}</div>
  ),
}));

jest.mock('./SiteTitleSync', () => ({
  __esModule: true,
  default: () => <div data-testid="site-title-sync" />,
}));

describe('mobile advanced chart shell isolation', () => {
  beforeEach(() => {
    mockPathname = '/';
  });

  test('skips PC Header and Footer on the embedded chart route', () => {
    mockPathname = '/mobile/advanced-chart';
    render(<AppChrome><div>chart</div></AppChrome>);

    expect(screen.getByText('chart')).toBeInTheDocument();
    expect(screen.queryByTestId('pc-header')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pc-footer')).not.toBeInTheDocument();
  });

  test('keeps PC Header and Footer on normal routes', () => {
    mockPathname = '/markets';
    render(<AppChrome><div>market</div></AppChrome>);

    expect(screen.getByTestId('pc-header')).toBeInTheDocument();
    expect(screen.getByTestId('pc-footer')).toBeInTheDocument();
  });

  test('skips private auth and title side effects on the public embedded route', () => {
    mockPathname = '/mobile/advanced-chart';
    render(<Providers><div>public chart</div></Providers>);

    expect(screen.getByText('public chart')).toBeInTheDocument();
    expect(screen.queryByTestId('private-auth-provider')).not.toBeInTheDocument();
    expect(screen.queryByTestId('site-title-sync')).not.toBeInTheDocument();
  });

  test('keeps the normal provider chain outside the embedded route', () => {
    mockPathname = '/markets';
    render(<Providers><div>normal page</div></Providers>);

    expect(screen.getByTestId('private-auth-provider')).toBeInTheDocument();
    expect(screen.getByTestId('site-title-sync')).toBeInTheDocument();
  });
});
