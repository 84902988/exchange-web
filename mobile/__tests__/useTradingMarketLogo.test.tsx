import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { useTradingMarketLogo } from '../src/hooks/useTradingMarketLogo';

const mockSpotCache = jest.fn();
const mockSpotFetch = jest.fn();
const mockContractCache = jest.fn();
const mockContractFetch = jest.fn();

jest.mock('../src/api/market', () => ({
  getCachedMobileMarkets: () => mockSpotCache(),
  fetchMobileMarkets: () => mockSpotFetch(),
}));
jest.mock('../src/api/tradingCatalog', () => ({
  getCachedContractTradingCatalog: () => mockContractCache(),
  fetchContractTradingCatalog: () => mockContractFetch(),
}));

type Props = {
  market?: 'spot' | 'contract';
  symbol?: string;
  routeLogoUrl?: string;
  active?: boolean;
};
let logo: string | null;
function Probe({
  market = 'spot',
  symbol = 'BTCUSDT',
  routeLogoUrl,
  active = true,
}: Props) {
  logo = useTradingMarketLogo(market, symbol, routeLogoUrl, active);
  return null;
}
function spot(symbol: string, logoUrl: string) {
  return {
    symbol: symbol.replace('USDT', ''),
    tradeSymbol: symbol,
    tradeMarket: 'spot',
    logoUrl,
  };
}

describe('useTradingMarketLogo', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.resetAllMocks();
    mockSpotCache.mockReturnValue([]);
    mockContractCache.mockReturnValue([]);
    mockSpotFetch.mockResolvedValue([]);
    mockContractFetch.mockResolvedValue([]);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('keeps a list-provided logo without starting a metadata request', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <Probe routeLogoUrl=" /uploads/list-btc.svg " />,
      );
    });
    expect(logo).toBe('/uploads/list-btc.svg');
    expect(mockSpotFetch).not.toHaveBeenCalled();
  });

  it('resolves the default spot tab from its exact cached trading symbol', async () => {
    mockSpotCache.mockReturnValue([
      spot('BTCUSDC', '/wrong-quote.png'),
      spot('BTCUSDT', '/uploads/btc.png'),
    ]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(logo).toBe('/uploads/btc.png');
    expect(mockSpotFetch).not.toHaveBeenCalled();
  });

  it('loads spot metadata on a cold default tab and ignores another market', async () => {
    mockSpotFetch.mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        tradeMarket: 'contract',
        logoUrl: '/wrong-market.svg',
      },
      spot('BTCUSDT', '/uploads/btc.svg'),
    ]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(logo).toBe('/uploads/btc.svg');
    expect(mockSpotFetch).toHaveBeenCalledTimes(1);
    expect(mockContractFetch).not.toHaveBeenCalled();
  });

  it('loads contract logos from the same catalog used by its selector', async () => {
    mockContractFetch.mockResolvedValue([
      { symbol: 'BTCUSDT_PERP', logoUrl: '/uploads/perp-btc.png' },
    ]);
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <Probe market="contract" symbol="BTCUSDT_PERP" />,
      );
    });
    expect(logo).toBe('/uploads/perp-btc.png');
    expect(mockSpotFetch).not.toHaveBeenCalled();
  });

  it('uses a legacy crypto row only when its full pair symbol matches', async () => {
    mockSpotCache.mockReturnValue([
      { symbol: 'BTC', category: 'crypto', logoUrl: '/ambiguous.png' },
      { symbol: 'BTCUSDT', category: 'crypto', logoUrl: '/legacy.png' },
    ]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(logo).toBe('/legacy.png');
  });

  it('does not show the previous symbol logo or apply its late response after switching', async () => {
    let resolveBtc!: (rows: unknown[]) => void;
    mockSpotFetch.mockReturnValueOnce(
      new Promise(resolve => {
        resolveBtc = resolve;
      }),
    );
    mockSpotFetch.mockResolvedValueOnce([spot('ETHUSDT', '/eth.png')]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    await act(async () => {
      renderer.update(<Probe symbol="ETHUSDT" />);
    });
    expect(logo).toBe('/eth.png');
    await act(async () => {
      resolveBtc([spot('BTCUSDT', '/late-btc.png')]);
    });
    expect(logo).toBe('/eth.png');
    await act(async () => {
      renderer.update(<Probe symbol="SOLUSDT" active={false} />);
    });
    expect(logo).toBeNull();
  });

  it('keeps the fallback on metadata failure and retries when the screen regains focus', async () => {
    mockSpotFetch.mockRejectedValueOnce(new Error('catalog offline'));
    mockSpotFetch.mockResolvedValueOnce([spot('BTCUSDT', '/recovered.png')]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(logo).toBeNull();
    await act(async () => {
      renderer.update(<Probe active={false} />);
    });
    await act(async () => {
      renderer.update(<Probe />);
    });
    expect(logo).toBe('/recovered.png');
  });

  it('does not request metadata in a hidden screen or invent a logo for an unknown symbol', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe active={false} />);
    });
    expect(mockSpotFetch).not.toHaveBeenCalled();
    mockSpotFetch.mockResolvedValue([spot('ETHUSDT', '/eth.png')]);
    await act(async () => {
      renderer.update(<Probe />);
    });
    expect(logo).toBeNull();
  });

  it('retains a cached logo when its catalog expires during an offline refresh', async () => {
    mockSpotCache.mockReturnValue([spot('BTCUSDT', '/cached-btc.png')]);
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(logo).toBe('/cached-btc.png');
    mockSpotCache.mockReturnValue([]);
    mockSpotFetch.mockRejectedValueOnce(new Error('offline after cache expiry'));
    await act(async () => {
      renderer.update(<Probe />);
    });
    expect(mockSpotFetch).toHaveBeenCalledTimes(1);
    expect(logo).toBe('/cached-btc.png');
    await act(async () => {
      renderer.update(<Probe symbol="ETHUSDT" active={false} />);
    });
    expect(logo).toBeNull();
  });
});
