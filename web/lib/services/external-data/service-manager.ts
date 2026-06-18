// 外部服务管理器
import {
  ExternalService,
  ExternalServiceConfig,
  ExternalServiceType,
  CryptoMarketServiceConfig,
  StockMarketServiceConfig,
  ForexMarketServiceConfig,
  WorldTimeServiceConfig
} from '@/types/external-services';
import { CryptoMarketService } from './crypto-market-service';
import { StockMarketService } from './stock-market-service';
import { ForexMarketService } from './forex-market-service';
import { WorldTimeService } from './world-time-service';

/**
 * 外部服务管理器类
 * 用于统一管理和访问所有外部服务实例
 */
export class ExternalServiceManager {
  private static instance: ExternalServiceManager;
  private services: Map<ExternalServiceType, ExternalService<ExternalServiceConfig>> = new Map();
  private initialized: boolean = false;

  private constructor() {
    // 单例模式，禁止外部实例化
  }

  /**
   * 获取服务管理器实例
   */
  public static getInstance(): ExternalServiceManager {
    if (!ExternalServiceManager.instance) {
      ExternalServiceManager.instance = new ExternalServiceManager();
    }
    return ExternalServiceManager.instance;
  }

  /**
   * 初始化所有外部服务
   * @param configs - 服务配置映射
   */
  public async initialize(configs: {
    cryptoMarket?: CryptoMarketServiceConfig;
    stockMarket?: StockMarketServiceConfig;
    forexMarket?: ForexMarketServiceConfig;
    worldTime?: WorldTimeServiceConfig;
  }): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    try {
      // 初始化加密货币市场服务
      if (configs.cryptoMarket?.enabled) {
        const cryptoService = new CryptoMarketService(configs.cryptoMarket);
        await cryptoService.initialize();
        this.services.set(ExternalServiceType.CRYPTO_MARKET, cryptoService);
      }

      // 初始化股票市场服务
      if (configs.stockMarket?.enabled) {
        const stockService = new StockMarketService(configs.stockMarket);
        await stockService.initialize();
        this.services.set(ExternalServiceType.STOCK_MARKET, stockService);
      }

      // 初始化货币市场服务
      if (configs.forexMarket?.enabled) {
        const forexService = new ForexMarketService(configs.forexMarket);
        await forexService.initialize();
        this.services.set(ExternalServiceType.FOREX_MARKET, forexService);
      }

      // 初始化世界时服务
      if (configs.worldTime?.enabled) {
        const timeService = new WorldTimeService(configs.worldTime);
        await timeService.initialize();
        this.services.set(ExternalServiceType.WORLD_TIME, timeService);
      }

      this.initialized = true;
      return true;
    } catch (error) {
      console.error('Failed to initialize external services:', error);
      this.initialized = false;
      return false;
    }
  }

  /**
   * 获取指定类型的服务实例
   * @param type - 服务类型
   * @returns 服务实例或undefined（如果服务未启用或初始化失败）
   */
  public getService<T extends ExternalService<ExternalServiceConfig>>(type: ExternalServiceType): T | undefined {
    return this.services.get(type) as T | undefined;
  }

  /**
   * 获取加密货币市场服务实例
   */
  public getCryptoMarketService(): CryptoMarketService | undefined {
    return this.getService<CryptoMarketService>(ExternalServiceType.CRYPTO_MARKET);
  }

  /**
   * 获取股票市场服务实例
   */
  public getStockMarketService(): StockMarketService | undefined {
    return this.getService<StockMarketService>(ExternalServiceType.STOCK_MARKET);
  }

  /**
   * 获取货币市场服务实例
   */
  public getForexMarketService(): ForexMarketService | undefined {
    return this.getService<ForexMarketService>(ExternalServiceType.FOREX_MARKET);
  }

  /**
   * 获取世界时服务实例
   */
  public getWorldTimeService(): WorldTimeService | undefined {
    return this.getService<WorldTimeService>(ExternalServiceType.WORLD_TIME);
  }

  /**
   * 检查所有服务的健康状态
   * @returns 所有服务的健康状态映射
   */
  public async checkAllServicesHealth(): Promise<Map<ExternalServiceType, boolean>> {
    const healthStatus = new Map<ExternalServiceType, boolean>();

    for (const [type, service] of this.services.entries()) {
      try {
        const isHealthy = await service.checkHealth();
        healthStatus.set(type, isHealthy);
      } catch (error) {
        console.error(`Health check failed for ${type}:`, error);
        healthStatus.set(type, false);
      }
    }

    return healthStatus;
  }

  /**
   * 获取已初始化的服务类型列表
   */
  public getInitializedServices(): ExternalServiceType[] {
    return Array.from(this.services.keys());
  }

  /**
   * 检查服务是否已初始化
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 重置服务管理器，清除所有服务实例
   */
  public reset(): void {
    this.services.clear();
    this.initialized = false;
  }
}

// 创建服务管理器单例实例
export const externalServiceManager = ExternalServiceManager.getInstance();
