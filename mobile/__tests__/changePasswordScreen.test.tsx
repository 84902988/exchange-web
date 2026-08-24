import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockChangeMyPassword = jest.fn();
const mockLogout = jest.fn();

jest.mock('../src/api', () => ({
  changeMyPassword: (...args: unknown[]) => mockChangeMyPassword(...args),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import { createTranslator } from '../src/i18n';
import ChangePasswordScreen from '../src/screens/account/ChangePasswordScreen';

describe('change password screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChangeMyPassword.mockResolvedValue({ passwordChanged: true });
    mockLogout.mockResolvedValue(undefined);
  });

  it('deduplicates the confirmation and password mutation', async () => {
    const t = createTranslator('zh-CN');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ChangePasswordScreen
          navigation={{ goBack: jest.fn(), reset: jest.fn() }}
        />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: t('password.current') })
        .props.onChangeText('OldPass!123');
      renderer.root
        .findByProps({ accessibilityLabel: t('password.new') })
        .props.onChangeText('NewPass!456');
      renderer.root
        .findByProps({ accessibilityLabel: t('password.confirmNew') })
        .props.onChangeText('NewPass!456');
    });

    const change = renderer.root.findByProps({
      accessibilityLabel: t('password.change'),
    });
    act(() => {
      change.props.onPress();
      change.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const confirm = alert.mock.calls[0][2]?.find(
      button => button.text === t('password.confirmChange'),
    );
    await act(async () => {
      await Promise.all([confirm?.onPress?.(), confirm?.onPress?.()]);
    });

    expect(mockChangeMyPassword).toHaveBeenCalledTimes(1);
    expect(mockChangeMyPassword).toHaveBeenCalledWith({
      old_password: 'OldPass!123',
      new_password: 'NewPass!456',
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    alert.mockRestore();
  });
});
