import {
  __resetTradingCatalogForTests,
  fetchContractTradingCatalog,
  resolveContractTradingInstrument,
  resolveSpotTradingInstrument,
} from '../src/api/tradingCatalog';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

describe('authoritative mobile trading catalog resolution', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    __resetTradingCatalogForTests();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('only resolves an exact enabled spot symbol with base and quote assets', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            symbol: 'ETHUSDT',
            base_asset: 'ETH',
            quote_asset: 'USDT',
            enabled: true,
            status: 1,
          },
          {
            symbol: 'BTCUSDT',
            display_symbol: 'BTC/USDT',
            base_asset: 'BTC',
            quote_asset: 'USDT',
            enabled: true,
            status: 1,
          },
        ],
      }),
    );

    await expect(resolveSpotTradingInstrument('btcusdt')).resolves.toEqual({
      symbol: 'BTCUSDT',
      displaySymbol: 'BTC/USDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
    });
  });

  it('maps a market provider symbol to an enabled contract symbol', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        data: {
          items: [
            {
              symbol: 'NAS100USDT_PERP',
              display_name: 'NAS100/USDT 永续',
              provider_symbol: 'NAS100',
              base_asset: 'NAS100',
              quote_asset: 'USDT',
              category: 'INDEX',
              status: 1,
            },
          ],
        },
      }),
    );

    await expect(
      resolveContractTradingInstrument('NAS100'),
    ).resolves.toMatchObject({
      symbol: 'NAS100USDT_PERP',
      baseAsset: 'NAS100',
      quoteAsset: 'USDT',
      category: 'INDEX',
    });
  });

  it('maps a USD market symbol to the authoritative USDT contract', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            symbol: 'XAGUSDT_PERP',
            display_name: 'XAG/USDT 永续',
            base_asset: 'XAG',
            quote_asset: 'USDT',
            category: 'GOLD',
            status: 1,
          },
        ],
      }),
    );

    await expect(
      resolveContractTradingInstrument('XAGUSD'),
    ).resolves.toMatchObject({
      symbol: 'XAGUSDT_PERP',
      baseAsset: 'XAG',
      quoteAsset: 'USDT',
      category: 'GOLD',
    });
  });

  it('returns null instead of guessing when no authoritative match exists', async () => {
    fetchMock.mockResolvedValue(jsonResponse({items: []}));

    await expect(
      resolveContractTradingInstrument('UNKNOWN'),
    ).resolves.toBeNull();
  });

  it.each([
    ['spot', resolveSpotTradingInstrument, 'BTCUSDT'],
    ['contract', resolveContractTradingInstrument, 'BTCUSDT'],
  ])(
    'rejects and does not negative-cache a malformed %s catalog',
    async (_case, resolveInstrument, symbol) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({unexpected: []}))
        .mockResolvedValueOnce(jsonResponse({items: []}));

      await expect(resolveInstrument(symbol)).rejects.toThrow(
        'invalid row container',
      );
      await expect(resolveInstrument(symbol)).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('single-flights identical catalog lookups', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>(resolve => {
      release = resolve;
    });
    fetchMock.mockReturnValue(gate);

    const first = resolveSpotTradingInstrument('BTCUSDT');
    const second = resolveSpotTradingInstrument('BTCUSDT');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(
      jsonResponse({
        items: [
          {
            symbol: 'BTCUSDT',
            base_asset: 'BTC',
            quote_asset: 'USDT',
            enabled: true,
            status: 1,
          },
        ],
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({symbol: 'BTCUSDT'}),
      expect.objectContaining({symbol: 'BTCUSDT'}),
    ]);
  });

  it('loads every enabled contract page and maps crypto, stock, and CFD categories', async () => {
    const makeRow = (index: number, category: string) => ({
      symbol: `ASSET${index}USDT_PERP`,
      display_name: `Asset ${index}`,
      provider_symbol: `ASSET${index}`,
      base_asset: `ASSET${index}`,
      quote_asset: 'USDT',
      category,
      status: 1,
      market_status: index === 114 ? 'CLOSED' : 'OPEN',
      base_asset_logo_url:
        index === 0 ? '/static/uploads/assets/asset0.svg' : null,
    });
    const rows = Array.from({length: 115}, (_, index) =>
      makeRow(index, index < 2 ? 'CRYPTO' : index < 106 ? 'STOCK' : 'INDEX'),
    );
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      const pageRows = page === 1 ? rows.slice(0, 100) : rows.slice(100);
      return Promise.resolve(
        jsonResponse({
          items: pageRows,
          total: rows.length,
          page,
          page_size: 100,
        }),
      );
    });

    const catalog = await fetchContractTradingCatalog();

    expect(catalog).toHaveLength(115);
    expect(catalog.filter(item => item.marketCategory === 'crypto')).toHaveLength(2);
    expect(catalog.filter(item => item.marketCategory === 'stock')).toHaveLength(104);
    expect(catalog.filter(item => item.marketCategory === 'cfd')).toHaveLength(9);
    expect(catalog[0]).toMatchObject({
      symbol: 'ASSET0USDT_PERP',
      displaySymbol: 'ASSET0/USDT',
      logoUrl: '/static/uploads/assets/asset0.svg',
    });
    expect(catalog[114].marketStatus).toBe('CLOSED');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a paginated contract catalog is incomplete', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [],
        total: 1,
        page: 1,
        page_size: 100,
      }),
    );

    await expect(fetchContractTradingCatalog()).rejects.toThrow(
      'incomplete result',
    );
  });
});
