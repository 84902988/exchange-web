/**
 * Mobile embeds use the native market-detail shell for navigation and controls.
 * Keep TradingView's chart/touch surface, while removing desktop chrome that
 * crowds a phone viewport. These flags are applied only when `mobileEmbed` is
 * true, so the regular PC charts keep their existing toolbars.
 */
export const MOBILE_TRADINGVIEW_DISABLED_FEATURES = [
  'border_around_the_chart',
  'control_bar',
  'context_menus',
  'edit_buttons_in_legend',
  'header_fullscreen_button',
  'header_saveload',
  'header_screenshot',
  'header_widget',
  // The native detail header already owns symbol/price context. Hiding the
  // documented legend widget removes TradingView's overlapping title/OHLC
  // status rows without reaching into the chart iframe.
  'legend_widget',
  'left_toolbar',
  'popup_hints',
  'timeframes_toolbar',
  'timezone_menu',
  'use_localstorage_for_settings',
  // The native mobile chart shell owns the surrounding product branding.
  // Disable TradingView's supported corner logo for this embedded profile.
  'widget_logo',
] as const;

export const MOBILE_TRADINGVIEW_ENABLED_FEATURES = [
  'hide_object_tree_and_price_scale_exchange_label',
  'hide_resolution_in_legend',
  'horz_touch_drag_scroll',
  'pinch_scale',
  'vert_touch_drag_scroll',
] as const;

/**
 * Next.js mounts its development indicator in a top-level custom element.
 * The advanced-chart route is rendered inside the native WebView, where that
 * development-only control would overlap TradingView's lower-left corner.
 * Keeping this CSS route-local avoids changing the regular desktop dev shell.
 */
export const MOBILE_ADVANCED_CHART_SHELL_CSS = `
  nextjs-portal {
    display: none !important;
  }
`;
