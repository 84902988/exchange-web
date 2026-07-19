const TRADINGVIEW_LIBRARY_SCRIPT_SRC = '/tradingview/charting_library/charting_library.js';

export default function TradeLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preload" href={TRADINGVIEW_LIBRARY_SCRIPT_SRC} as="script" />
      {children}
    </>
  );
}
