export type ResponsiveSizeClass =
  | 'compact'
  | 'phone'
  | 'tablet'
  | 'expanded';

export type ResponsiveContentWidth =
  | 'standard'
  | 'dashboard'
  | 'wide'
  | 'fluid';

export const TABLET_MIN_SHORT_SIDE = 600;
export const COMPACT_PHONE_MAX_WIDTH = 359;
export const TABLET_TAB_BAR_MAX_WIDTH = 720;

export const RESPONSIVE_CONTENT_MAX_WIDTH = {
  standard: 720,
  dashboard: 960,
  wide: 1180,
} as const;

export type ResponsiveLayout = {
  contentMaxWidth: number | undefined;
  horizontalPadding: number;
  isLandscape: boolean;
  isTablet: boolean;
  shouldStackTradingPanels: boolean;
  sizeClass: ResponsiveSizeClass;
  tabBarHorizontalInset: number;
};

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveResponsiveLayout(
  width: number,
  height: number,
  fontScale = 1,
  contentWidth: ResponsiveContentWidth = 'standard',
): ResponsiveLayout {
  const safeWidth = finitePositive(width, 360);
  const safeHeight = finitePositive(height, 640);
  const safeFontScale = finitePositive(fontScale, 1);
  const shortSide = Math.min(safeWidth, safeHeight);
  const isTablet = shortSide >= TABLET_MIN_SHORT_SIDE;
  const isLandscape = safeWidth > safeHeight;
  const sizeClass: ResponsiveSizeClass =
    safeWidth <= COMPACT_PHONE_MAX_WIDTH
      ? 'compact'
      : isTablet
      ? safeWidth >= 1200
        ? 'expanded'
        : 'tablet'
      : 'phone';
  const horizontalPadding = isTablet
    ? 24
    : sizeClass === 'compact' || safeFontScale >= 1.25
    ? 12
    : 16;
  const contentMaxWidth =
    contentWidth === 'fluid'
      ? undefined
      : RESPONSIVE_CONTENT_MAX_WIDTH[contentWidth];
  const tabBarHorizontalInset = isTablet
    ? Math.max(0, (safeWidth - TABLET_TAB_BAR_MAX_WIDTH) / 2)
    : 0;

  return {
    contentMaxWidth,
    horizontalPadding,
    isLandscape,
    isTablet,
    shouldStackTradingPanels:
      safeWidth <= COMPACT_PHONE_MAX_WIDTH ||
      (safeWidth < 480 && safeFontScale >= 1.35),
    sizeClass,
    tabBarHorizontalInset,
  };
}

export function resolveAppOrientation({
  isPad,
  screenHeight,
  screenWidth,
}: {
  isPad: boolean;
  screenHeight: number;
  screenWidth: number;
}) {
  const safeWidth = finitePositive(screenWidth, 360);
  const safeHeight = finitePositive(screenHeight, 640);
  const isPhysicalTablet =
    isPad || Math.min(safeWidth, safeHeight) >= TABLET_MIN_SHORT_SIDE;

  return isPhysicalTablet ? 'all' : 'portrait_up';
}
