// 货币市场数据服务
import {
  ForexMarketServiceConfig,
  ExternalServiceType,
  ForexSymbol,
  ForexRate
} from '@/types/external-services';
import { BaseExternalService } from './base-service';

/**
 * 货币市场数据服务类
 */
export class ForexMarketService extends BaseExternalService<ForexMarketServiceConfig> {
  constructor(config: ForexMarketServiceConfig) {
    super(config, 'forex-market', ExternalServiceType.FOREX_MARKET);
  }

  /**
   * 执行健康检查
   */
  protected async performHealthCheck(): Promise<boolean> {
    try {
      // 简单的健康检查：获取一个常用货币对的汇率
      const response = await this.getRate('USD/CNY');
      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取货币对列表
   * @returns 货币对列表
   */
  async getSymbols(): Promise<{ success: boolean; data?: ForexSymbol[] }> {
    const response = await this.request<ForexSymbol[]>('/symbols');
    return response;
  }

  /**
   * 获取单个货币对的汇率
   * @param symbol - 货币对符号（如 USD/CNY）
   * @returns 汇率数据
   */
  async getRate(symbol: string): Promise<{ success: boolean; data?: ForexRate }> {
    const response = await this.request<ForexRate>(`/rate/${symbol}`);
    return response;
  }

  /**
   * 获取多个货币对的汇率
   * @param symbols - 货币对符号列表
   * @returns 多个货币对的汇率数据
   */
  async getRates(symbols: string[]): Promise<{ success: boolean; data?: ForexRate[] }> {
    const response = await this.request<ForexRate[]>(`/rates`, {
      method: 'POST',
      body: JSON.stringify({ symbols })
    });
    return response;
  }

  /**
   * 获取所有主要货币对的汇率
   * @returns 主要货币对的汇率数据
   */
  async getMajorRates(): Promise<{ success: boolean; data?: ForexRate[] }> {
    const response = await this.request<ForexRate[]>('/major-rates');
    return response;
  }

  /**
   * 获取货币对的历史汇率数据
   * @param symbol - 货币对符号
   * @param startDate - 开始日期（YYYY-MM-DD）
   * @param endDate - 结束日期（YYYY-MM-DD）
   * @returns 历史汇率数据列表
   */
  async getHistoricalRates(symbol: string, startDate: string, endDate: string): Promise<{ success: boolean; data?: any[] }> {
    const path = this.formatUrl(`/historical/${symbol}`, { startDate, endDate });
    const response = await this.request<any[]>(path);
    return response;
  }

  /**
   * 获取交叉汇率
   * @param baseCurrency - 基础货币
   * @param quoteCurrencies - 报价货币列表
   * @returns 交叉汇率数据
   */
  async getCrossRates(baseCurrency: string, quoteCurrencies: string[]): Promise<{ success: boolean; data?: Record<string, number> }> {
    const response = await this.request<Record<string, number>>('/cross-rates', {
      method: 'POST',
      body: JSON.stringify({ baseCurrency, quoteCurrencies })
    });
    return response;
  }
}
