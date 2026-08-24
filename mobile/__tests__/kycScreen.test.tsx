import React from 'react';
import { Alert, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LanguageProvider, MOBILE_LOCALE_STORAGE_KEY } from '../src/i18n';

const mockFetchMyKyc = jest.fn();
const mockSubmitMyKyc = jest.fn();
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
}));

jest.mock('../src/api/kyc', () => {
  const actual = jest.requireActual('../src/api/kyc');
  return {
    ...actual,
    fetchMyKyc: (...args: unknown[]) => mockFetchMyKyc(...args),
    submitMyKyc: (...args: unknown[]) => mockSubmitMyKyc(...args),
  };
});

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    isLoggedIn: true,
    restoreSession: jest.fn(async () => undefined),
  }),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import KycScreen from '../src/screens/account/KycScreen';

function collectText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

describe('mobile KYC screen localization', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    mockFetchMyKyc.mockResolvedValue({
      kycStatus: 'NONE',
      kycLevel: 0,
      latestSubmission: null,
    });
  });

  afterEach(async () => {
    await AsyncStorage.removeItem(MOBILE_LOCALE_STORAGE_KEY);
  });

  it('renders the unverified form and local validation in English', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <KycScreen />
        </LanguageProvider>,
      );
    });

    const text = collectText(renderer);
    expect(text).toContain('Identity verification');
    expect(text).toContain('Identity not yet verified');
    expect(text).toContain('Level 1 identity verification');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Back' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Upload Document front',
      }),
    ).toBeTruthy();

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Submit verification documents' })
        .props.onPress();
    });
    expect(collectText(renderer)).toContain('Enter your legal name.');
    expect(mockSubmitMyKyc).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('keeps an operator review note in its original language', async () => {
    mockFetchMyKyc.mockResolvedValue({
      kycStatus: 'REJECTED',
      kycLevel: 0,
      latestSubmission: {
        id: 8,
        kycLevel: 'PRIMARY',
        fullName: 'Test User',
        countryCode: 'CN',
        idType: 'PASSPORT',
        idNumber: 'P1234567',
        frontImageUrl: '/front',
        backImageUrl: null,
        selfieImageUrl: '/selfie',
        reviewStatus: 'REJECTED',
        reviewNote: '证件照片反光',
        reviewedAt: null,
        createdAt: '2026-08-01T10:00:00',
        updatedAt: null,
      },
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <KycScreen />
        </LanguageProvider>,
      );
    });

    const text = collectText(renderer);
    expect(text).toContain('Verification unsuccessful');
    expect(text).toContain('证件照片反光');
    act(() => renderer.unmount());
  });

  it('opens one image-source dialog during rapid repeated presses', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <KycScreen />
        </LanguageProvider>,
      );
    });

    const uploadFront = renderer.root.findByProps({
      accessibilityLabel: 'Upload Document front',
    });
    act(() => {
      uploadFront.props.onPress();
      uploadFront.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);
    const cancel = alert.mock.calls[0][2]?.find(
      button => button.style === 'cancel',
    );
    act(() => cancel?.onPress?.());
    act(() => renderer.unmount());
    alert.mockRestore();
  });
});
