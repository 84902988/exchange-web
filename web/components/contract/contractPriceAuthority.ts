type ContractPriceInput = string | number | null | undefined;

export type ContractPriceDomain =
  | 'TRADES'
  | 'KLINE'
  | 'TICKER'
  | 'EXECUTION'
  | 'UNAVAILABLE';

export type ContractReferencePriceRole = 'LAST_TRADE' | 'KLINE_CLOSE' | 'LAST_PRICE' | 'UNAVAILABLE';

export type ContractExecutionIntent =
  | 'OPEN_LONG'
  | 'OPEN_SHORT'
  | 'CLOSE_LONG'
  | 'CLOSE_SHORT';

export type ContractPriceEvidence = {
  value: number | null;
  domain: ContractPriceDomain;
  source: string | null;
  provider: string | null;
  freshness: string | null;
  eventTimeMs: number | null;
  usable: boolean;
  rejectReason: string | null;
  symbol: string;
};

export type ContractReferencePrice = ContractPriceEvidence & {
  role: ContractReferencePriceRole;
};

export type ContractTradeReferenceInput = {
  symbol?: string | null;
  price?: ContractPriceInput;
  time?: string | number | null;
  source?: string | null;
  freshness?: string | null;
  priceSource?: string | null;
  synthetic?: boolean | null;
};

export type ContractKlineReferenceInput = {
  symbol?: string | null;
  close?: ContractPriceInput;
  time?: string | number | null;
  freshness?: string | null;
  priceSource?: string | null;
  klineMode?: string | null;
};

export type ContractTickerReferenceInput = {
  symbol?: string | null;
  price?: ContractPriceInput;
  time?: string | number | null;
  source?: string | null;
  freshness?: string | null;
  marketStatus?: string | null;
  marketSessionType?: string | null;
};

export type ContractExecutionBookInput = {
  symbol?: string | null;
  bid?: ContractPriceInput;
  ask?: ContractPriceInput;
  executable?: boolean | null;
  mode?: string | null;
  freshness?: string | null;
  source?: string | null;
  time?: string | number | null;
};

export type BuildContractPriceAuthorityInput = {
  symbol: string;
  trade?: ContractTradeReferenceInput | null;
  kline?: ContractKlineReferenceInput | null;
  ticker?: ContractTickerReferenceInput | null;
  execution?: ContractExecutionBookInput | null;
  nowMs?: number;
};

export type ContractPriceAuthorityV1 = {
  symbol: string;
  reference_price: ContractReferencePrice;
  execution_bid: ContractPriceEvidence;
  execution_ask: ContractPriceEvidence;
  executable: boolean;
  executionMode: string | null;
};

export type ResolveContractExecutionPriceInput = {
  authority: ContractPriceAuthorityV1;
  intent: ContractExecutionIntent;
  expectedSymbol?: string | null;
};

export type ResolvedContractExecutionPrice = {
  price: number | null;
  basis: 'EXECUTION_BID' | 'EXECUTION_ASK';
  executable: boolean;
  rejectReason: string | null;
  evidence: ContractPriceEvidence;
};

const REFERENCE_FRESHNESSES = new Set(['LIVE', 'RECENT', 'FRESH', 'CURRENT']);
const TRADE_MAX_QUOTE_LAG_MS = 60_000;
const TRADE_MAX_FUTURE_SKEW_MS = 30_000;
const KLINE_FRESHNESSES = new Set([...REFERENCE_FRESHNESSES, 'CACHED']);
const NON_TRADING_TICKER_FRESHNESSES = new Set([
  ...KLINE_FRESHNESSES,
  'LAST_VALID',
  'LAST_GOOD',
  'STALE',
]);
const NON_TRADING_SESSION_TOKENS = new Set([
  'PRE_MARKET',
  'AFTER_HOURS',
  'CLOSED',
  'HOLIDAY',
]);

function normalizeToken(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || null;
}

function normalizeSymbol(value: unknown): string {
  return normalizeToken(value) || '';
}

function positiveNumber(value: ContractPriceInput): number | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestampMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !Number.isFinite(Number(value))) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function unavailableEvidence(
  symbol: string,
  domain: ContractPriceDomain,
  rejectReason: string,
): ContractPriceEvidence {
  return {
    value: null,
    domain,
    source: null,
    provider: null,
    freshness: null,
    eventTimeMs: null,
    usable: false,
    rejectReason,
    symbol,
  };
}

function buildTradeEvidence(
  targetSymbol: string,
  input?: ContractTradeReferenceInput | null,
): ContractPriceEvidence {
  if (!input) return unavailableEvidence(targetSymbol, 'TRADES', 'TRADE_EVIDENCE_MISSING');

  const symbol = normalizeSymbol(input.symbol);
  const value = positiveNumber(input.price);
  const eventTimeMs = timestampMs(input.time);
  const source = normalizeToken(input.source);
  const freshness = normalizeToken(input.freshness);
  const priceSource = normalizeToken(input.priceSource);
  let rejectReason: string | null = null;

  if (!targetSymbol || !symbol || symbol !== targetSymbol) rejectReason = 'SYMBOL_MISMATCH';
  else if (input.synthetic === true || priceSource === 'SYNTHETIC_FROM_QUOTE') {
    rejectReason = 'SYNTHETIC_TRADE';
  } else if (priceSource !== 'TRADE_TICK') rejectReason = 'TRADE_PROVENANCE_INVALID';
  else if (value === null) rejectReason = 'LAST_TRADE_MISSING';
  else if (eventTimeMs === null) rejectReason = 'TRADE_TIME_MISSING';
  else if (!source) rejectReason = 'TRADE_SOURCE_MISSING';
  else if (!freshness || !REFERENCE_FRESHNESSES.has(freshness)) {
    rejectReason = freshness === 'STALE' ? 'STALE' : 'FRESHNESS_UNUSABLE';
  }

  return {
    value,
    domain: 'TRADES',
    source: priceSource,
    provider: source,
    freshness,
    eventTimeMs,
    usable: rejectReason === null,
    rejectReason,
    symbol: symbol || targetSymbol,
  };
}

function buildKlineEvidence(
  targetSymbol: string,
  input?: ContractKlineReferenceInput | null,
): ContractPriceEvidence {
  if (!input) return unavailableEvidence(targetSymbol, 'KLINE', 'KLINE_EVIDENCE_MISSING');

  const symbol = normalizeSymbol(input.symbol);
  const value = positiveNumber(input.close);
  const eventTimeMs = timestampMs(input.time);
  const freshness = normalizeToken(input.freshness);
  const priceSource = normalizeToken(input.priceSource);
  const klineMode = normalizeToken(input.klineMode);
  let rejectReason: string | null = null;

  if (!targetSymbol || !symbol || symbol !== targetSymbol) rejectReason = 'SYMBOL_MISMATCH';
  else if (klineMode !== 'PROVIDER_KLINE' || priceSource !== 'KLINE_CLOSE') {
    rejectReason = 'KLINE_PROVENANCE_INVALID';
  } else if (value === null) rejectReason = 'KLINE_CLOSE_MISSING';
  else if (eventTimeMs === null) rejectReason = 'KLINE_TIME_MISSING';
  else if (!freshness || !KLINE_FRESHNESSES.has(freshness)) {
    rejectReason = freshness === 'STALE' ? 'STALE' : 'FRESHNESS_UNUSABLE';
  }

  return {
    value,
    domain: 'KLINE',
    source: priceSource,
    provider: klineMode,
    freshness,
    eventTimeMs,
    usable: rejectReason === null,
    rejectReason,
    symbol: symbol || targetSymbol,
  };
}

function buildTickerEvidence(
  targetSymbol: string,
  input?: ContractTickerReferenceInput | null,
): ContractPriceEvidence {
  if (!input) return unavailableEvidence(targetSymbol, 'TICKER', 'TICKER_EVIDENCE_MISSING');

  const symbol = normalizeSymbol(input.symbol);
  const value = positiveNumber(input.price);
  const eventTimeMs = timestampMs(input.time);
  const provider = normalizeToken(input.source);
  const freshness = normalizeToken(input.freshness);
  const marketStatus = normalizeToken(input.marketStatus);
  const marketSessionType = normalizeToken(input.marketSessionType);
  const isNonTradingSession = NON_TRADING_SESSION_TOKENS.has(marketStatus || '')
    || NON_TRADING_SESSION_TOKENS.has(marketSessionType || '');
  const permittedFreshness = isNonTradingSession
    ? NON_TRADING_TICKER_FRESHNESSES
    : REFERENCE_FRESHNESSES;
  let rejectReason: string | null = null;

  if (!targetSymbol || !symbol || symbol !== targetSymbol) rejectReason = 'SYMBOL_MISMATCH';
  else if (value === null) rejectReason = 'LAST_PRICE_MISSING';
  else if (eventTimeMs === null) rejectReason = 'TICKER_TIME_MISSING';
  else if (!provider) rejectReason = 'TICKER_SOURCE_MISSING';
  else if (!freshness || !permittedFreshness.has(freshness)) {
    rejectReason = freshness === 'STALE' ? 'STALE' : 'FRESHNESS_UNUSABLE';
  }

  return {
    value,
    domain: 'TICKER',
    source: 'LAST_PRICE',
    provider,
    freshness,
    eventTimeMs,
    usable: rejectReason === null,
    rejectReason,
    symbol: symbol || targetSymbol,
  };
}

function applyTradeOrderingGuard(
  trade: ContractPriceEvidence,
  kline: ContractPriceEvidence,
  ticker: ContractPriceEvidence,
  nowMs: number,
): ContractPriceEvidence {
  if (!trade.usable || trade.eventTimeMs === null) return trade;

  let rejectReason: string | null = null;
  if (trade.eventTimeMs > nowMs + TRADE_MAX_FUTURE_SKEW_MS) {
    rejectReason = 'TRADE_TIME_IN_FUTURE';
  } else if (
    kline.usable
    && kline.eventTimeMs !== null
    && trade.eventTimeMs < kline.eventTimeMs
  ) {
    // Kline evidence uses the active provider bucket open time. A cached trade
    // from an older bucket must never override the currently displayed candle.
    rejectReason = 'TRADE_OLDER_THAN_KLINE';
  } else if (
    ticker.usable
    && ticker.eventTimeMs !== null
    && ticker.eventTimeMs - trade.eventTimeMs > TRADE_MAX_QUOTE_LAG_MS
  ) {
    // This primarily fences localStorage trade rows during rapid symbol
    // revisit. A current quote may be newer than the latest real trade, but an
    // entire minute of lag is no longer suitable as a live Header authority.
    rejectReason = 'TRADE_TOO_OLD_FOR_QUOTE';
  }

  return rejectReason
    ? { ...trade, usable: false, rejectReason }
    : trade;
}

function selectReferencePrice(
  targetSymbol: string,
  trade: ContractPriceEvidence,
  kline: ContractPriceEvidence,
  ticker: ContractPriceEvidence,
  hadTradeInput: boolean,
  hadKlineInput: boolean,
  hadTickerInput: boolean,
): ContractReferencePrice {
  if (trade.usable) return { ...trade, role: 'LAST_TRADE' };
  if (kline.usable) return { ...kline, role: 'KLINE_CLOSE' };
  if (ticker.usable) return { ...ticker, role: 'LAST_PRICE' };

  const rejectReason = hadTradeInput
    ? trade.rejectReason
    : hadKlineInput
      ? kline.rejectReason
      : hadTickerInput
        ? ticker.rejectReason
        : 'REFERENCE_PRICE_UNAVAILABLE';
  return {
    ...unavailableEvidence(targetSymbol, 'UNAVAILABLE', rejectReason || 'REFERENCE_PRICE_UNAVAILABLE'),
    role: 'UNAVAILABLE',
  };
}

function executionRejectReason(
  targetSymbol: string,
  input?: ContractExecutionBookInput | null,
): string | null {
  if (!input) return 'BBO_MISSING';
  const symbol = normalizeSymbol(input.symbol);
  const bid = positiveNumber(input.bid);
  const ask = positiveNumber(input.ask);
  const mode = normalizeToken(input.mode);
  const freshness = normalizeToken(input.freshness);

  if (!targetSymbol || !symbol || symbol !== targetSymbol) return 'SYMBOL_MISMATCH';
  if (bid === null || ask === null) return 'BBO_MISSING';
  if (ask < bid) return 'BBO_CROSSED';
  if (input.executable !== true) return 'MARKET_NOT_EXECUTABLE';
  if (mode !== 'LIVE_BBO') return 'EXECUTION_MODE_NOT_ALLOWED';
  if (freshness !== 'LIVE') return freshness === 'STALE' ? 'STALE' : 'FRESHNESS_UNUSABLE';
  return null;
}

function buildExecutionEvidence(
  targetSymbol: string,
  input: ContractExecutionBookInput | null | undefined,
  side: 'bid' | 'ask',
  rejectReason: string | null,
): ContractPriceEvidence {
  const symbol = normalizeSymbol(input?.symbol) || targetSymbol;
  return {
    value: rejectReason ? null : positiveNumber(side === 'bid' ? input?.bid : input?.ask),
    domain: 'EXECUTION',
    source: normalizeToken(input?.source),
    provider: null,
    freshness: normalizeToken(input?.freshness),
    eventTimeMs: timestampMs(input?.time),
    usable: rejectReason === null,
    rejectReason,
    symbol,
  };
}

export function buildContractPriceAuthority(
  input: BuildContractPriceAuthorityInput,
): ContractPriceAuthorityV1 {
  const symbol = normalizeSymbol(input.symbol);
  const kline = buildKlineEvidence(symbol, input.kline);
  const ticker = buildTickerEvidence(symbol, input.ticker);
  const trade = applyTradeOrderingGuard(
    buildTradeEvidence(symbol, input.trade),
    kline,
    ticker,
    typeof input.nowMs === 'number' && Number.isFinite(input.nowMs)
      ? input.nowMs
      : Date.now(),
  );
  const executionFailure = executionRejectReason(symbol, input.execution);
  const executionBid = buildExecutionEvidence(symbol, input.execution, 'bid', executionFailure);
  const executionAsk = buildExecutionEvidence(symbol, input.execution, 'ask', executionFailure);

  return {
    symbol,
    reference_price: selectReferencePrice(
      symbol,
      trade,
      kline,
      ticker,
      input.trade !== null && input.trade !== undefined,
      input.kline !== null && input.kline !== undefined,
      input.ticker !== null && input.ticker !== undefined,
    ),
    execution_bid: executionBid,
    execution_ask: executionAsk,
    executable: executionFailure === null,
    executionMode: normalizeToken(input.execution?.mode),
  };
}

export function selectContractReferencePrice(
  authority: ContractPriceAuthorityV1,
): ContractReferencePrice {
  return authority.reference_price;
}

export function resolveContractExecutionPrice(
  input: ResolveContractExecutionPriceInput,
): ResolvedContractExecutionPrice {
  const useAsk = input.intent === 'OPEN_LONG' || input.intent === 'CLOSE_SHORT';
  const evidence = useAsk ? input.authority.execution_ask : input.authority.execution_bid;
  const basis = useAsk ? 'EXECUTION_ASK' : 'EXECUTION_BID';
  const expectedSymbol = normalizeSymbol(input.expectedSymbol) || input.authority.symbol;
  let rejectReason: string | null = null;

  if (
    normalizeSymbol(input.authority.symbol) !== expectedSymbol
    || normalizeSymbol(evidence.symbol) !== expectedSymbol
  ) {
    rejectReason = 'SYMBOL_MISMATCH';
  } else if (!input.authority.executable) {
    rejectReason = evidence.rejectReason || 'MARKET_NOT_EXECUTABLE';
  } else if (!evidence.usable || evidence.value === null) {
    rejectReason = evidence.rejectReason || 'EXECUTION_PRICE_UNAVAILABLE';
  }

  return {
    price: rejectReason ? null : evidence.value,
    basis,
    executable: rejectReason === null,
    rejectReason,
    evidence,
  };
}
