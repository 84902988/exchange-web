// 外部数据服务模块索引

// 基础服务抽象类
export { BaseExternalService } from './base-service';

// 具体服务实现
export { CryptoMarketService } from './crypto-market-service';
export { StockMarketService } from './stock-market-service';
export { ForexMarketService } from './forex-market-service';
export { WorldTimeService } from './world-time-service';

// 服务管理器
export { ExternalServiceManager, externalServiceManager } from './service-manager';

// 配置管理器
export { ExternalServiceConfigManager, externalServiceConfigManager } from './config-manager';

// 类型导入（方便使用）
export type {
  ExternalService,
  ExternalServiceConfig,
  ExternalServiceType,
  ExternalServiceResponse,
  ExternalServiceError,
  CryptoMarketServiceConfig,
  StockMarketServiceConfig,
  ForexMarketServiceConfig,
  WorldTimeServiceConfig,
  CryptoSymbol,
  CryptoTicker,
  KlineData,
  KlineRequestParams,
  OrderBook,
  StockSymbol,
  StockTicker,
  ForexSymbol,
  ForexRate,
  TimeZoneInfo
} from '@/types/external-services';
