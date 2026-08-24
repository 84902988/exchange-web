import {
  resolveAppOrientation,
  resolveResponsiveLayout,
} from '../src/constants/responsiveLayout';

describe('shared responsive layout', () => {
  it.each([
    {
      device: 'iPhone SE',
      width: 320,
      height: 568,
      sizeClass: 'compact',
      padding: 12,
      tablet: false,
      stackTrading: true,
    },
    {
      device: 'iPhone 15',
      width: 393,
      height: 852,
      sizeClass: 'phone',
      padding: 16,
      tablet: false,
      stackTrading: false,
    },
    {
      device: 'Android phone',
      width: 412,
      height: 915,
      sizeClass: 'phone',
      padding: 16,
      tablet: false,
      stackTrading: false,
    },
    {
      device: 'iPad portrait',
      width: 768,
      height: 1024,
      sizeClass: 'tablet',
      padding: 24,
      tablet: true,
      stackTrading: false,
    },
    {
      device: 'Android tablet landscape',
      width: 1280,
      height: 800,
      sizeClass: 'expanded',
      padding: 24,
      tablet: true,
      stackTrading: false,
    },
    {
      device: 'iPad Pro landscape',
      width: 1366,
      height: 1024,
      sizeClass: 'expanded',
      padding: 24,
      tablet: true,
      stackTrading: false,
    },
  ] as const)(
    'resolves $device without device-model branches',
    ({height, padding, sizeClass, stackTrading, tablet, width}) => {
      const layout = resolveResponsiveLayout(width, height, 1, 'wide');

      expect(layout).toMatchObject({
        contentMaxWidth: 1180,
        horizontalPadding: padding,
        isTablet: tablet,
        shouldStackTradingPanels: stackTrading,
        sizeClass,
      });
    },
  );

  it('treats split-screen iPad content as a compact window while preserving readable gutters', () => {
    const layout = resolveResponsiveLayout(500, 1024, 1, 'dashboard');

    expect(layout.isTablet).toBe(false);
    expect(layout.sizeClass).toBe('phone');
    expect(layout.horizontalPadding).toBe(16);
    expect(layout.contentMaxWidth).toBe(960);
  });

  it('reduces phone gutters and stacks trading panels for enlarged text', () => {
    const layout = resolveResponsiveLayout(430, 932, 1.4, 'wide');

    expect(layout.horizontalPadding).toBe(12);
    expect(layout.shouldStackTradingPanels).toBe(true);
  });

  it('centers tablet tab actions inside a bounded interaction width', () => {
    expect(resolveResponsiveLayout(1366, 1024).tabBarHorizontalInset).toBe(323);
    expect(resolveResponsiveLayout(393, 852).tabBarHorizontalInset).toBe(0);
  });

  it('keeps phones portrait-stable and enables rotation only for physical tablets', () => {
    expect(
      resolveAppOrientation({
        isPad: false,
        screenHeight: 852,
        screenWidth: 393,
      }),
    ).toBe('portrait_up');
    expect(
      resolveAppOrientation({
        isPad: true,
        screenHeight: 1024,
        screenWidth: 500,
      }),
    ).toBe('all');
    expect(
      resolveAppOrientation({
        isPad: false,
        screenHeight: 1280,
        screenWidth: 800,
      }),
    ).toBe('all');
  });
});
