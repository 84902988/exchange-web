import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockLaunchImageLibrary = jest.fn();
const mockRefreshUser = jest.fn();
const mockUpdateMyProfile = jest.fn();
const mockUploadMyAvatar = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: (...args: unknown[]) => mockLaunchImageLibrary(...args),
}));

jest.mock('../src/api', () => ({
  updateMyProfile: (...args: unknown[]) => mockUpdateMyProfile(...args),
  uploadMyAvatar: (...args: unknown[]) => mockUploadMyAvatar(...args),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    refreshUser: mockRefreshUser,
    user: {
      id: 7,
      email: 'user@example.com',
      profile: { nickname: 'Mobile User', username: 'mobile-user' },
    },
  }),
}));

jest.mock('../src/i18n', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import ProfileEditScreen from '../src/screens/account/ProfileEditScreen';

describe('profile image picker lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefreshUser.mockResolvedValue(undefined);
    mockUpdateMyProfile.mockResolvedValue(undefined);
    mockUploadMyAvatar.mockResolvedValue(undefined);
  });

  it('opens one picker and ignores its result after the screen unmounts', async () => {
    let resolvePicker!: (value: {
      assets: Array<{
        uri: string;
        type: string;
        fileName: string;
        fileSize: number;
      }>;
    }) => void;
    mockLaunchImageLibrary.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolvePicker = resolve;
        }),
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ProfileEditScreen navigation={{ goBack: jest.fn() }} />,
      );
    });
    const chooseAvatar = renderer.root.findByProps({
      accessibilityLabel: 'profile.chooseAvatar',
    });
    let firstPick!: Promise<void>;
    act(() => {
      firstPick = chooseAvatar.props.onPress();
      chooseAvatar.props.onPress();
    });
    expect(mockLaunchImageLibrary).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    await act(async () => {
      resolvePicker({
        assets: [
          {
            uri: 'file:///avatar.webp',
            type: 'image/webp',
            fileName: 'avatar.webp',
            fileSize: 1024,
          },
        ],
      });
      await firstPick;
    });
    expect(mockUploadMyAvatar).not.toHaveBeenCalled();
  });
});
