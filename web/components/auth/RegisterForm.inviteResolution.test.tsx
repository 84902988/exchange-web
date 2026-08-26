import { validateBdInvite, validateUserInvite } from '@/lib/api';

import { resolveInviteInfo } from './RegisterForm';

jest.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  register: jest.fn(),
  sendOtp: jest.fn(),
  validateBdInvite: jest.fn(),
  validateUserInvite: jest.fn(),
}));

const mockedValidateBdInvite = jest.mocked(validateBdInvite);
const mockedValidateUserInvite = jest.mocked(validateUserInvite);

beforeEach(() => {
  jest.clearAllMocks();
});

test('a legacy link without invite_type stays an ordinary invite', async () => {
  mockedValidateUserInvite.mockResolvedValue({
    type: 'user',
    valid: true,
    invite_code: 'U29',
    inviter_name: 'member@example.com',
  });

  await expect(resolveInviteInfo('U29', '')).resolves.toEqual({
    type: 'user',
    invite_code: 'U29',
    inviter_name: 'member@example.com',
  });
  expect(mockedValidateUserInvite).toHaveBeenCalledWith('U29');
  expect(mockedValidateBdInvite).not.toHaveBeenCalled();
});

test('BD attribution only uses an explicitly typed BD link', async () => {
  mockedValidateBdInvite.mockResolvedValue({
    type: 'bd',
    valid: true,
    invite_code: 'BD100000029',
  });

  await expect(resolveInviteInfo('BD100000029', 'bd')).resolves.toEqual({
    type: 'bd',
    invite_code: 'BD100000029',
  });
  expect(mockedValidateBdInvite).toHaveBeenCalledWith('BD100000029');
  expect(mockedValidateUserInvite).not.toHaveBeenCalled();
});
