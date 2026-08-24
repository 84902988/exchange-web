const fs = require('fs');
const path = require('path');

describe('mobile runtime performance configuration', () => {
  test('defers module evaluation in Metro bundles', () => {
    const metroConfig = fs.readFileSync(
      path.join(__dirname, '../metro.config.js'),
      'utf8',
    );
    expect(metroConfig).toContain('getTransformOptions');
    expect(metroConfig).toContain('experimentalImportSupport: false');
    expect(metroConfig).toContain('inlineRequires: true');
  });

  test('detaches inactive tabs without queueing frozen tab work', () => {
    const appRoot = fs.readFileSync(
      path.join(__dirname, '../src/app/AppRoot.tsx'),
      'utf8',
    );
    const mainTabs = fs.readFileSync(
      path.join(__dirname, '../src/navigation/MainTabs.tsx'),
      'utf8',
    );
    const homeScreen = fs.readFileSync(
      path.join(__dirname, '../src/screens/home/HomeScreen.tsx'),
      'utf8',
    );
    const tabButton = fs.readFileSync(
      path.join(
        __dirname,
        '../src/components/navigation/ResponsiveTabBarButton.tsx',
      ),
      'utf8',
    );
    const homeData = fs.readFileSync(
      path.join(__dirname, '../src/hooks/useMobileHomeData.ts'),
      'utf8',
    );

    expect(appRoot).toContain('enableScreens(true)');
    expect(appRoot).toContain('enableFreeze(true)');
    expect(mainTabs).toContain('detachInactiveScreens');
    expect(mainTabs).toContain('freezeOnBlur: false');
    expect(mainTabs).toContain("animation: 'none'");
    expect(homeScreen).toContain('usePreloadMainTabs(preloadMainTab)');
    expect(tabButton).toContain('onPress={handlePress}');
    expect(tabButton).toContain('beginMainTabTransitionBudget()');
    expect(tabButton).toContain('transform: [{scale: 0.97}]');
    expect(homeData).toContain('startTransition(() =>');
  });

  test('keeps paginated financial histories on virtualized lists', () => {
    for (const relativePath of [
      '../src/screens/assets/AssetHistoryScreen.tsx',
      '../src/screens/assets/UserTransferRecordsScreen.tsx',
      '../src/screens/account/SecurityEventsScreen.tsx',
      '../src/screens/home/HomeMessageCenterScreen.tsx',
    ]) {
      const source = fs.readFileSync(
        path.join(__dirname, relativePath),
        'utf8',
      );
      expect(source).toContain('<FlatList');
      expect(source).toContain('initialNumToRender={8}');
      expect(source).toContain('maxToRenderPerBatch={8}');
      expect(source).toContain('windowSize={7}');
      expect(source).toContain(
        "removeClippedSubviews={Platform.OS === 'android'}",
      );
    }
  });
});
