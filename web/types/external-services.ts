// 外部数据服务集成类型定义

/**
 * 外部服务统一错误类型
 * @property {string} code - 错误代码
 * @property {string} message - 错误消息
 * @property {string} [detail] - 错误详情
 * @property {string} [provider] - 服务提供商名称
 * @property {number} [status] - HTTP状态码（如果适用）
 */
export interface ExternalServiceError {
  code: string;
  message: string;
  detail?: string;
  provider?: string;
  status?: number;
}

/**
 * 外部服务统一响应类型
 * @template T - 响应数据类型
 * @property {boolean} success - 请求是否成功
 * @property {T} [data] - 响应数据（成功时）
 * @property {ExternalServiceError} [error] - 错误信息（失败时）
 * @property {string} provider - 服务提供商名称
 * @property {number} [latency] - 请求延迟（毫秒）
 */
export interface ExternalServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: ExternalServiceError;
  provider: string;
  latency?: number;
}

/**
 * 外部服务配置基础类型
 * @property {string} apiKey - API密钥
 * @property {string} baseUrl - API基础URL
 * @property {string} [version] - API版本号
 * @property {number} timeout - 请求超时时间（毫秒）
 * @property {boolean} enabled - 是否启用该服务
 * @property {Record<string, string>} [headers] - 额外请求头
 */
export interface ExternalServiceConfig {
  apiKey: string;
  baseUrl: string;
  version?: string;
  timeout: number;
  enabled: boolean;
  headers?: Record<string, string>;
}

/**
 * 外部服务类型枚举
 */
export enum ExternalServiceType {
  CRYPTO_MARKET = 'crypto_market',
  STOCK_MARKET = 'stock_market',
  FOREX_MARKET = 'forex_market',
  WORLD_TIME = 'world_time'
}

// 1. 加密货币市场数据接口类型定义

/**
 * 加密货币交易对类型
 * @property {string} symbol - 交易对符号（如 BTC-USDT）
 * @property {string} baseAsset - 基础资产
 * @property {string} quoteAsset - 报价资产
 * @property {string} [exchange] - 交易所名称
 */
export interface CryptoSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  exchange?: string;
}

/**
 * 加密货币实时行情类型
 * @property {string} symbol - 交易对符号
 * @property {number} price - 当前价格
 * @property {number} open24h - 24小时开盘价
 * @property {number} high24h - 24小时最高价
 * @property {number} low24h - 24小时最低价
 * @property {number} volume24h - 24小时成交量
 * @property {number} change24h - 24小时价格变化
 * @property {number} changePercent24h - 24小时价格变化百分比
 * @property {string} timestamp - 时间戳
 */
export interface CryptoTicker {
  symbol: string;
  price: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  change24h: number;
  changePercent24h: number;
  timestamp: string;
}

/**
 * K线数据类型
 * @property {string} timestamp - 时间戳
 * @property {number} open - 开盘价
 * @property {number} high - 最高价
 * @property {number} low - 最低价
 * @property {number} close - 收盘价
 * @property {number} volume - 成交量
 */
export interface KlineData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * K线数据请求参数
 * @property {string} symbol - 交易对符号
 * @property {string} interval - K线间隔（如 1m, 5m, 1h, 1d）
 * @property {number} [limit] - 返回数据数量
 * @property {string} [startTime] - 开始时间戳
 * @property {string} [endTime] - 结束时间戳
 */
export interface KlineRequestParams {
  symbol: string;
  interval: string;
  limit?: number;
  startTime?: string;
  endTime?: string;
}

/**
 * 订单簿数据类型
 * @property {Array<[string, string]>} bids - 买单列表 [价格, 数量]
 * @property {Array<[string, string]>} asks - 卖单列表 [价格, 数量]
 * @property {string} timestamp - 时间戳
 * @property {number} [updateId] - 更新ID
 */
export interface OrderBook {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  timestamp: string;
  updateId?: number;
}

/**
 * 加密货币市场服务配置
 */
export interface CryptoMarketServiceConfig extends ExternalServiceConfig {
  type: ExternalServiceType.CRYPTO_MARKET;
  exchanges?: string[]; // 支持的交易所列表
  rateLimit?: number; // 每秒请求限制
}

// 2. 股票交易市场数据接口类型定义

/**
 * 股票代码类型
 * @property {string} symbol - 股票代码
 * @property {string} name - 股票名称
 * @property {string} market - 市场（如 NASDAQ, NYSE）
 * @property {string} [currency] - 交易货币
 */
export interface StockSymbol {
  symbol: string;
  name: string;
  market: string;
  currency?: string;
}

/**
 * 股票实时行情类型
 * @property {string} symbol - 股票代码
 * @property {number} price - 当前价格
 * @property {number} open - 开盘价
 * @property {number} high - 最高价
 * @property {number} low - 最低价
 * @property {number} volume - 成交量
 * @property {number} change - 价格变化
 * @property {number} changePercent - 价格变化百分比
 * @property {string} timestamp - 时间戳
 * @property {string} [marketStatus] - 市场状态（如 OPEN, CLOSED）
 */
export interface StockTicker {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  change: number;
  changePercent: number;
  timestamp: string;
  marketStatus?: string;
}

/**
 * 股票市场服务配置
 */
export interface StockMarketServiceConfig extends ExternalServiceConfig {
  type: ExternalServiceType.STOCK_MARKET;
  markets?: string[]; // 支持的市场列表
  realtimeEnabled?: boolean; // 是否启用实时数据
}

// 3. 货币市场数据接口类型定义

/**
 * 货币对类型
 * @property {string} symbol - 货币对符号（如 USD/CNY）
 * @property {string} baseCurrency - 基础货币
 * @property {string} quoteCurrency - 报价货币
 */
export interface ForexSymbol {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
}

/**
 * 货币汇率类型
 * @property {string} symbol - 货币对符号
 * @property {number} rate - 汇率
 * @property {number} ask - 卖出价
 * @property {number} bid - 买入价
 * @property {number} change24h - 24小时变化
 * @property {number} changePercent24h - 24小时变化百分比
 * @property {string} timestamp - 时间戳
 */
export interface ForexRate {
  symbol: string;
  rate: number;
  ask: number;
  bid: number;
  change24h: number;
  changePercent24h: number;
  timestamp: string;
}

/**
 * 货币市场服务配置
 */
export interface ForexMarketServiceConfig extends ExternalServiceConfig {
  type: ExternalServiceType.FOREX_MARKET;
  rateLimit?: number; // 每秒请求限制
  crossRatesEnabled?: boolean; // 是否启用交叉汇率计算
}

// 4. 精准世界时数据接口类型定义

/**
 * 时区信息类型
 * @property {string} zoneName - 时区名称
 * @property {string} abbreviation - 时区缩写
 * @property {number} gmtOffset - GMT偏移量（秒）
 * @property {boolean} dst - 是否启用夏令时
 * @property {string} timestamp - 当前时间戳
 * @property {string} formatted - 格式化时间
 */
export interface TimeZoneInfo {
  zoneName: string;
  abbreviation: string;
  gmtOffset: number;
  dst: boolean;
  timestamp: string;
  formatted: string;
}

/**
 * 世界时服务配置
 */
export interface WorldTimeServiceConfig extends ExternalServiceConfig {
  type: ExternalServiceType.WORLD_TIME;
  cacheTtl?: number; // 缓存时间（秒）
  defaultTimeZone?: string; // 默认时区
}

// 统一的外部服务配置类型
export type ExternalServiceConfigMap = {
  [ExternalServiceType.CRYPTO_MARKET]: CryptoMarketServiceConfig;
  [ExternalServiceType.STOCK_MARKET]: StockMarketServiceConfig;
  [ExternalServiceType.FOREX_MARKET]: ForexMarketServiceConfig;
  [ExternalServiceType.WORLD_TIME]: WorldTimeServiceConfig;
};

/**
 * 外部服务集成抽象层通用接口
 * @template T - 服务配置类型
 */
export interface ExternalService<T extends ExternalServiceConfig> {
  /**
   * 获取服务配置
   */
  getConfig(): T;
  
  /**
   * 初始化服务
   */
  initialize(): Promise<boolean>;
  
  /**
   * 检查服务健康状态
   */
  checkHealth(): Promise<boolean>;
  
  /**
   * 获取服务类型
   */
  getType(): ExternalServiceType;
}

// 外部服务工厂函数类型
export type ExternalServiceFactory = <T extends ExternalServiceConfig>(
  config: T
) => ExternalService<T>;
