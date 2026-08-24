module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|react-native-webview|react-native-qrcode-svg|@react-native(-community)?|@react-navigation|@react-native-async-storage)/)',
  ],
};
