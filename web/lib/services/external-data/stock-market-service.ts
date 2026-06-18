// 股票市场数据服务
import {
  StockMarketServiceConfig,
  ExternalServiceType,
  StockSymbol,
  StockTicker
} from '@/types/external-services';
import { BaseExternalService } from './base-service';

/**
 * 股票市场数据服务类
 */
export class StockMarketService extends BaseExternalService<StockMarketServiceConfig> {
  constructor(config: StockMarketServiceConfig) {
    super(config, 'stock-market', ExternalServiceType.STOCK_MARKET);
  }

  /**
   * 执行健康检查
   */
  protected async performHealthCheck(): Promise<boolean> {
    try {
      // 简单的健康检查：获取一个常用股票的行情
      const response = await this.getTicker('AAPL');
      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取股票代码列表
   * @param market - 市场代码（如 NASDAQ, NYSE）
   * @returns 股票代码列表
   */
  async getSymbols(market?: string): Promise<{ success: boolean; data?: StockSymbol[] }> {
    const path = this.formatUrl('/symbols', { market });
    const response = await this.request<StockSymbol[]>(path);
    return response;
  }

  /**
   * 获取单个股票的实时行情
   * @param symbol - 股票代码（如 AAPL）
   * @returns 实时行情数据
   */
  async getTicker(symbol: string): Promise<{ success: boolean; data?: StockTicker }> {
    const response = await this.request<StockTicker>(`/ticker/${symbol}`);
    return response;
  }

  /**
   * 获取多个股票的实时行情
   * @param symbols - 股票代码列表
   * @returns 多个股票的行情数据
   */
  async getTickers(symbols: string[]): Promise<{ success: boolean; data?: StockTicker[] }> {
    const response = await this.request<StockTicker[]>(`/tickers`, {
      method: 'POST',
      body: JSON.stringify({ symbols })
    });
    return response;
  }

  /**
   * 获取股票K线数据
   * @param symbol - 股票代码
   * @param interval - K线间隔（如 1m, 5m, 1h, 1d）
   * @param limit - 返回数据数量（默认100）
   * @returns K线数据列表
   */
  async getKlines(symbol: string, interval: string, limit: number = 100): Promise<{ success: boolean; data?: unknown[] }> {
    const path = this.formatUrl(`/klines/${symbol}/${interval}`, { limit });
    const response = await this.request<unknown[]>(path);
    return response;
  }

  /**
   * 获取股票历史数据
   * @param symbol - 股票代码
   * @param startDate - 开始日期（YYYY-MM-DD）
   * @param endDate - 结束日期（YYYY-MM-DD）
   * @returns 历史数据列表
   */
  async getHistoricalData(symbol: string, startDate: string, endDate: string): Promise<{ success: boolean; data?: unknown[] }> {
    const path = this.formatUrl(`/historical/${symbol}`, { startDate, endDate });
    const response = await this.request<unknown[]>(path);
    return response;
  }

  /**
   * 获取股票基本信息
   * @param symbol - 股票代码
   * @returns 股票基本信息
   */
  async getCompanyProfile(symbol: string): Promise<{ success: boolean; data?: unknown }> {
    const response = await this.request<unknown>(`/profile/${symbol}`);
    return response;
  }

  /**
   * 获取股票财务数据
   * @param symbol - 股票代码
   * @param reportType - 报告类型（annual, quarterly）
   * @returns 财务数据
   */
  async getFinancials(symbol: string, reportType: 'annual' | 'quarterly' = 'annual'): Promise<{ success: boolean; data?: unknown }> {
    const path = this.formatUrl(`/financials/${symbol}`, { reportType });
    const response = await this.request<unknown>(path);
    return response;
  }
}
