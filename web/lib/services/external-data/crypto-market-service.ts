// 加密货币市场数据服务
import {
  CryptoMarketServiceConfig,
  ExternalServiceType,
  CryptoSymbol,
  CryptoTicker,
  KlineData,
  KlineRequestParams,
  OrderBook
} from '@/types/external-services';
import { BaseExternalService } from './base-service';

/**
 * 加密货币市场数据服务类
 */
export class CryptoMarketService extends BaseExternalService<CryptoMarketServiceConfig> {
  constructor(config: CryptoMarketServiceConfig) {
    super(config, 'crypto-market', ExternalServiceType.CRYPTO_MARKET);
  }

  /**
   * 执行健康检查
   */
  protected async performHealthCheck(): Promise<boolean> {
    try {
      // 简单的健康检查：获取一个常用交易对的行情
      const response = await this.getTicker('BTC-USDT');
      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取加密货币交易对列表
   * @returns 交易对列表
   */
  async getSymbols(): Promise<{ success: boolean; data?: CryptoSymbol[] }> {
    const response = await this.request<CryptoSymbol[]>('/symbols');
    return response;
  }

  /**
   * 获取单个交易对的实时行情
   * @param symbol - 交易对符号（如 BTC-USDT）
   * @returns 实时行情数据
   */
  async getTicker(symbol: string): Promise<{ success: boolean; data?: CryptoTicker }> {
    const response = await this.request<CryptoTicker>(`/ticker/${symbol}`);
    return response;
  }

  /**
   * 获取多个交易对的实时行情
   * @param symbols - 交易对符号列表
   * @returns 多个交易对的行情数据
   */
  async getTickers(symbols: string[]): Promise<{ success: boolean; data?: CryptoTicker[] }> {
    const response = await this.request<CryptoTicker[]>(`/tickers`, {
      method: 'POST',
      body: JSON.stringify({ symbols })
    });
    return response;
  }

  /**
   * 获取K线数据
   * @param params - K线请求参数
   * @returns K线数据列表
   */
  async getKlines(params: KlineRequestParams): Promise<{ success: boolean; data?: KlineData[] }> {
    const { symbol, interval, limit = 100, startTime, endTime } = params;
    const path = this.formatUrl(`/klines/${symbol}/${interval}`, {
      limit,
      startTime,
      endTime
    });
    const response = await this.request<KlineData[]>(path);
    return response;
  }

  /**
   * 获取订单簿数据
   * @param symbol - 交易对符号
   * @param limit - 返回的订单数量（默认100）
   * @returns 订单簿数据
   */
  async getOrderBook(symbol: string, limit: number = 100): Promise<{ success: boolean; data?: OrderBook }> {
    const path = this.formatUrl(`/orderbook/${symbol}`, { limit });
    const response = await this.request<OrderBook>(path);
    return response;
  }

  /**
   * 获取交易历史数据
   * @param symbol - 交易对符号
   * @param limit - 返回的交易数量（默认100）
   * @returns 交易历史数据
   */
  async getTradeHistory(symbol: string, limit: number = 100): Promise<{ success: boolean; data?: any[] }> {
    const path = this.formatUrl(`/trades/${symbol}`, { limit });
    const response = await this.request<any[]>(path);
    return response;
  }

  /**
   * 获取市场深度数据
   * @param symbol - 交易对符号
   * @param level - 深度级别（默认5）
   * @returns 市场深度数据
   */
  async getDepth(symbol: string, level: number = 5): Promise<{ success: boolean; data?: any }> {
    const path = this.formatUrl(`/depth/${symbol}`, { level });
    const response = await this.request<any>(path);
    return response;
  }
}
