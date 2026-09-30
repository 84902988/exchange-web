import { fireEvent, render, screen } from '@testing-library/react';
import MobileMenu from './MobileMenu';
import { withBankPortal } from '@/lib/bankPortal';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/lib/authContext', () => ({ useAuth: () => ({ logout: jest.fn() }) }));
jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({ t: (key: string) => ({
    navBankPortal: 'Bank',
  }[key] || key) }),
}));

test('mobile web menu opens the coming-soon page and closes the menu', () => {
  const onClose = jest.fn();
  render(<MobileMenu open onClose={onClose} isLoggedIn={false} menuItems={withBankPortal([], null)} />);
  const link = screen.getByRole('link', { name: 'Bank' });
  expect(link).toHaveAttribute('href', '/bank');
  expect(link).not.toHaveAttribute('target', '_blank');
  fireEvent.click(link);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('mobile web menu opens the configured portal in a separate tab', () => {
  const onClose = jest.fn();
  render(<MobileMenu open onClose={onClose} isLoggedIn menuItems={withBankPortal([], 'https://bank.example.com/portal')} />);
  const link = screen.getByRole('link', { name: 'Bank' });
  expect(link).toHaveAttribute('href', 'https://bank.example.com/portal');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  fireEvent.click(link);
  expect(onClose).toHaveBeenCalledTimes(1);
});
