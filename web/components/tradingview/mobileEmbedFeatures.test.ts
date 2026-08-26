import {
  MOBILE_ADVANCED_CHART_SHELL_CSS,
  MOBILE_TRADINGVIEW_DISABLED_FEATURES,
  MOBILE_TRADINGVIEW_ENABLED_FEATURES,
} from './mobileEmbedFeatures';

describe('mobile Advanced Charts feature profile', () => {
  test('removes desktop chrome while retaining touch chart interaction', () => {
    expect(MOBILE_TRADINGVIEW_ENABLED_FEATURES).toEqual(expect.arrayContaining([
      'horz_touch_drag_scroll',
      'vert_touch_drag_scroll',
      'pinch_scale',
    ]));
    expect(MOBILE_TRADINGVIEW_DISABLED_FEATURES).toEqual(expect.arrayContaining([
      'header_widget',
      'legend_widget',
      'left_toolbar',
      'edit_buttons_in_legend',
      'context_menus',
    ]));
  });

  test('hides the overlapping symbol and OHLC legend through the supported feature flag', () => {
    expect(MOBILE_TRADINGVIEW_DISABLED_FEATURES).toContain('legend_widget');
    expect(MOBILE_TRADINGVIEW_ENABLED_FEATURES).not.toContain('legend_widget');
  });

  test('removes controls duplicated by the native full-screen shell', () => {
    expect(MOBILE_TRADINGVIEW_DISABLED_FEATURES).toEqual(expect.arrayContaining([
      'header_fullscreen_button',
      'header_screenshot',
      'timeframes_toolbar',
      'control_bar',
      'widget_logo',
    ]));
  });

  test('keeps the Next.js development indicator out of the native WebView', () => {
    expect(MOBILE_ADVANCED_CHART_SHELL_CSS).toContain('nextjs-portal');
    expect(MOBILE_ADVANCED_CHART_SHELL_CSS).toContain('display: none !important');
  });

  test('does not persist desktop chart settings into the embedded session', () => {
    expect(MOBILE_TRADINGVIEW_DISABLED_FEATURES).toContain(
      'use_localstorage_for_settings',
    );
  });
});
