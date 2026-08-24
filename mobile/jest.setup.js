/* eslint-env jest */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);

jest.mock('react-native-keychain', () => {
  const credentialsByService = new Map();
  const getService = options => options?.service || '';
  const storeCredentials = async (username, password, options) => {
    const service = getService(options);
    const credentials = {
      username,
      password,
      service,
      storage: 'mock-keychain',
    };
    credentialsByService.set(service, credentials);
    return {service, storage: 'mock-keychain'};
  };
  return {
    ACCESSIBLE: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
    },
    setGenericPassword: jest.fn(storeCredentials),
    getGenericPassword: jest.fn(
      async options => credentialsByService.get(getService(options)) || false,
    ),
    resetGenericPassword: jest.fn(async options => {
      credentialsByService.delete(getService(options));
      return true;
    }),
    __resetMock: () => {
      credentialsByService.clear();
    },
    __storeMockCredentials: storeCredentials,
  };
});

// The real package requires an Android/iOS TurboModule. App-level Jest tests
// run without a native runtime; focused WebView tests replace this with their
// own controllable mock and assert the full event contract.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const MockWebView = React.forwardRef((props, ref) =>
    React.createElement('WebView', {...props, ref}),
  );
  return {
    __esModule: true,
    default: MockWebView,
    WebView: MockWebView,
  };
});

jest.mock('react-native-image-picker', () => ({
  launchCamera: jest.fn(async () => ({didCancel: true})),
  launchImageLibrary: jest.fn(async () => ({didCancel: true})),
}));
