// 世界时数据服务
import {
  WorldTimeServiceConfig,
  ExternalServiceType,
  TimeZoneInfo
} from '@/types/external-services';
import { BaseExternalService } from './base-service';

/**
 * 世界时数据服务类
 */
export class WorldTimeService extends BaseExternalService<WorldTimeServiceConfig> {
  constructor(config: WorldTimeServiceConfig) {
    super(config, 'world-time', ExternalServiceType.WORLD_TIME);
  }

  /**
   * 执行健康检查
   */
  protected async performHealthCheck(): Promise<boolean> {
    try {
      // 简单的健康检查：获取UTC时间
      const response = await this.getTimeByZone('UTC');
      return response.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取指定时区的时间信息
   * @param timezone - 时区名称（如 Asia/Shanghai, UTC）
   * @returns 时区时间信息
   */
  async getTimeByZone(timezone: string): Promise<{ success: boolean; data?: TimeZoneInfo }> {
    const response = await this.request<TimeZoneInfo>(`/timezone/${timezone}`);
    return response;
  }

  /**
   * 获取当前UTC时间
   * @returns UTC时间信息
   */
  async getUtcTime(): Promise<{ success: boolean; data?: TimeZoneInfo }> {
    return this.getTimeByZone('UTC');
  }

  /**
   * 获取所有可用时区列表
   * @returns 时区名称列表
   */
  async getAvailableTimezones(): Promise<{ success: boolean; data?: string[] }> {
    const response = await this.request<string[]>('/timezones');
    return response;
  }

  /**
   * 获取多个时区的时间信息
   * @param timezones - 时区名称列表
   * @returns 多个时区的时间信息
   */
  async getTimesByZones(timezones: string[]): Promise<{ success: boolean; data?: TimeZoneInfo[] }> {
    const response = await this.request<TimeZoneInfo[]>(`/times`, {
      method: 'POST',
      body: JSON.stringify({ timezones })
    });
    return response;
  }

  /**
   * 根据经纬度获取时区信息
   * @param lat - 纬度
   * @param lng - 经度
   * @returns 时区时间信息
   */
  async getTimeByCoordinates(lat: number, lng: number): Promise<{ success: boolean; data?: TimeZoneInfo }> {
    const path = this.formatUrl(`/time/coordinates`, { lat, lng });
    const response = await this.request<TimeZoneInfo>(path);
    return response;
  }
}
