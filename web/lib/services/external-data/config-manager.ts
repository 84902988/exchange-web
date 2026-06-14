// 外部服务配置管理器
import {
  ExternalServiceType,
  CryptoMarketServiceConfig,
  StockMarketServiceConfig,
  ForexMarketServiceConfig,
  WorldTimeServiceConfig
} from '@/types/external-services';

/**
 * 外部服务配置管理器类
 * 用于加载和管理外部服务的配置
 */
export class ExternalServiceConfigManager {
  private static instance: ExternalServiceConfigManager;
  private configs: {
    cryptoMarket?: CryptoMarketServiceConfig;
    stockMarket?: StockMarketServiceConfig;
    forexMarket?: ForexMarketServiceConfig;
    worldTime?: WorldTimeServiceConfig;
  } = {};

  private constructor() {
    // 单例模式，禁止外部实例化
    this.loadConfigsFromEnv();
  }

  /**
   * 获取配置管理器实例
   */
  public static getInstance(): ExternalServiceConfigManager {
    if (!ExternalServiceConfigManager.instance) {
      ExternalServiceConfigManager.instance = new ExternalServiceConfigManager();
    }
    return ExternalServiceConfigManager.instance;
  }

  /**
   * 从环境变量加载配置
   */
  private loadConfigsFromEnv(): void {
    // 加载加密货币市场服务配置
    this.configs.cryptoMarket = {
      type: ExternalServiceType.CRYPTO_MARKET,
      apiKey: process.env.NEXT_PUBLIC_CRYPTO_MARKET_API_KEY || '',
      baseUrl: process.env.NEXT_PUBLIC_CRYPTO_MARKET_BASE_URL || 'https://api.crypto-market.example.com',
      version: process.env.NEXT_PUBLIC_CRYPTO_MARKET_VERSION || 'v1',
      timeout: parseInt(process.env.NEXT_PUBLIC_CRYPTO_MARKET_TIMEOUT || '30000'),
      enabled: process.env.NEXT_PUBLIC_CRYPTO_MARKET_ENABLED === 'true',
      exchanges: process.env.NEXT_PUBLIC_CRYPTO_MARKET_EXCHANGES?.split(',') || undefined,
      rateLimit: parseInt(process.env.NEXT_PUBLIC_CRYPTO_MARKET_RATE_LIMIT || '10')
    };

    // 加载股票市场服务配置
    this.configs.stockMarket = {
      type: ExternalServiceType.STOCK_MARKET,
      apiKey: process.env.NEXT_PUBLIC_STOCK_MARKET_API_KEY || '',
      baseUrl: process.env.NEXT_PUBLIC_STOCK_MARKET_BASE_URL || 'https://api.stock-market.example.com',
      version: process.env.NEXT_PUBLIC_STOCK_MARKET_VERSION || 'v1',
      timeout: parseInt(process.env.NEXT_PUBLIC_STOCK_MARKET_TIMEOUT || '30000'),
      enabled: process.env.NEXT_PUBLIC_STOCK_MARKET_ENABLED === 'true',
      markets: process.env.NEXT_PUBLIC_STOCK_MARKET_MARKETS?.split(',') || undefined,
      realtimeEnabled: process.env.NEXT_PUBLIC_STOCK_MARKET_REALTIME_ENABLED === 'true'
    };

    // 加载货币市场服务配置
    this.configs.forexMarket = {
      type: ExternalServiceType.FOREX_MARKET,
      apiKey: process.env.NEXT_PUBLIC_FOREX_MARKET_API_KEY || '',
      baseUrl: process.env.NEXT_PUBLIC_FOREX_MARKET_BASE_URL || 'https://api.forex-market.example.com',
      version: process.env.NEXT_PUBLIC_FOREX_MARKET_VERSION || 'v1',
      timeout: parseInt(process.env.NEXT_PUBLIC_FOREX_MARKET_TIMEOUT || '30000'),
      enabled: process.env.NEXT_PUBLIC_FOREX_MARKET_ENABLED === 'true',
      rateLimit: parseInt(process.env.NEXT_PUBLIC_FOREX_MARKET_RATE_LIMIT || '10'),
      crossRatesEnabled: process.env.NEXT_PUBLIC_FOREX_MARKET_CROSS_RATES_ENABLED === 'true'
    };

    // 加载世界时服务配置
    this.configs.worldTime = {
      type: ExternalServiceType.WORLD_TIME,
      apiKey: process.env.NEXT_PUBLIC_WORLD_TIME_API_KEY || '',
      baseUrl: process.env.NEXT_PUBLIC_WORLD_TIME_BASE_URL || 'https://api.world-time.example.com',
      version: process.env.NEXT_PUBLIC_WORLD_TIME_VERSION || 'v1',
      timeout: parseInt(process.env.NEXT_PUBLIC_WORLD_TIME_TIMEOUT || '30000'),
      enabled: process.env.NEXT_PUBLIC_WORLD_TIME_ENABLED === 'true',
      cacheTtl: parseInt(process.env.NEXT_PUBLIC_WORLD_TIME_CACHE_TTL || '300'),
      defaultTimeZone: process.env.NEXT_PUBLIC_WORLD_TIME_DEFAULT_TIMEZONE || 'UTC'
    };
  }

  /**
   * 获取所有服务配置
   */
  public getAllConfigs() {
    return { ...this.configs };
  }

  /**
   * 获取加密货币市场服务配置
   */
  public getCryptoMarketConfig(): CryptoMarketServiceConfig {
    return this.configs.cryptoMarket as CryptoMarketServiceConfig;
  }

  /**
   * 获取股票市场服务配置
   */
  public getStockMarketConfig(): StockMarketServiceConfig {
    return this.configs.stockMarket as StockMarketServiceConfig;
  }

  /**
   * 获取货币市场服务配置
   */
  public getForexMarketConfig(): ForexMarketServiceConfig {
    return this.configs.forexMarket as ForexMarketServiceConfig;
  }

  /**
   * 获取世界时服务配置
   */
  public getWorldTimeConfig(): WorldTimeServiceConfig {
    return this.configs.worldTime as WorldTimeServiceConfig;
  }

  /**
   * 更新加密货币市场服务配置
   * @param config - 新的配置
   */
  public updateCryptoMarketConfig(config: Partial<CryptoMarketServiceConfig>): void {
    this.configs.cryptoMarket = {
      ...this.configs.cryptoMarket,
      ...config,
      type: ExternalServiceType.CRYPTO_MARKET
    } as CryptoMarketServiceConfig;
  }

  /**
   * 更新股票市场服务配置
   * @param config - 新的配置
   */
  public updateStockMarketConfig(config: Partial<StockMarketServiceConfig>): void {
    this.configs.stockMarket = {
      ...this.configs.stockMarket,
      ...config,
      type: ExternalServiceType.STOCK_MARKET
    } as StockMarketServiceConfig;
  }

  /**
   * 更新货币市场服务配置
   * @param config - 新的配置
   */
  public updateForexMarketConfig(config: Partial<ForexMarketServiceConfig>): void {
    this.configs.forexMarket = {
      ...this.configs.forexMarket,
      ...config,
      type: ExternalServiceType.FOREX_MARKET
    } as ForexMarketServiceConfig;
  }

  /**
   * 更新世界时服务配置
   * @param config - 新的配置
   */
  public updateWorldTimeConfig(config: Partial<WorldTimeServiceConfig>): void {
    this.configs.worldTime = {
      ...this.configs.worldTime,
      ...config,
      type: ExternalServiceType.WORLD_TIME
    } as WorldTimeServiceConfig;
  }

  /**
   * 重置所有配置为默认值
   */
  public reset(): void {
    this.loadConfigsFromEnv();
  }

  /**
   * 检查配置是否有效
   * @returns 是否有效
   */
  public isValid(): boolean {
    // 检查至少有一个服务被启用
    const enabledServices = Object.values(this.configs).filter(config => config?.enabled);
    return enabledServices.length > 0;
  }
}

// 创建配置管理器单例实例
export const externalServiceConfigManager = ExternalServiceConfigManager.getInstance();
