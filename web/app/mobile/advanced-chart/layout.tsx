import { MOBILE_ADVANCED_CHART_SHELL_CSS } from '@/components/tradingview/mobileEmbedFeatures';

const TRADINGVIEW_LIBRARY_SCRIPT_SRC =
  '/tradingview/charting_library/charting_library.js';

export default function MobileAdvancedChartLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <link rel="preload" href={TRADINGVIEW_LIBRARY_SCRIPT_SRC} as="script" />
      <style>{MOBILE_ADVANCED_CHART_SHELL_CSS}</style>
      {children}
    </>
  );
}
