// 外部数据服务基础抽象类
import {
  ExternalService,
  ExternalServiceConfig,
  ExternalServiceType,
  ExternalServiceResponse,
  ExternalServiceError
} from '@/types/external-services';

type ServiceErrorLike = {
  message?: string;
  code?: string;
  status?: number;
};

const isServiceErrorLike = (value: unknown): value is ServiceErrorLike => (
  typeof value === 'object' && value !== null
);

/**
 * 外部服务基础抽象类
 * @template T - 服务配置类型
 */
export abstract class BaseExternalService<T extends ExternalServiceConfig> implements ExternalService<T> {
  protected config: T;
  protected name: string;
  protected type: ExternalServiceType;
  protected initialized: boolean = false;
  protected lastHealthCheck: number = 0;

  /**
   * 构造函数
   * @param config - 服务配置
   * @param name - 服务名称
   * @param type - 服务类型
   */
  constructor(config: T, name: string, type: ExternalServiceType) {
    this.config = config;
    this.name = name;
    this.type = type;
  }

  /**
   * 获取服务配置
   */
  getConfig(): T {
    return this.config;
  }

  /**
   * 获取服务名称
   */
  getName(): string {
    return this.name;
  }

  /**
   * 获取服务类型
   */
  getType(): ExternalServiceType {
    return this.type;
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return true;
    }

    if (!this.config.enabled) {
      this.initialized = true;
      return true;
    }

    try {
      // 检查API密钥是否有效
      const isHealthy = await this.checkHealth();
      this.initialized = isHealthy;
      return isHealthy;
    } catch (error) {
      console.error(`Failed to initialize ${this.name}:`, error);
      this.initialized = false;
      return false;
    }
  }

  /**
   * 检查服务健康状态
   */
  async checkHealth(): Promise<boolean> {
    const now = Date.now();
    // 5分钟内的健康检查结果可以复用
    if (now - this.lastHealthCheck < 5 * 60 * 1000 && this.initialized) {
      return true;
    }

    try {
      // 实现健康检查逻辑
      const isHealthy = await this.performHealthCheck();
      this.lastHealthCheck = now;
      return isHealthy;
    } catch (error) {
      console.error(`Health check failed for ${this.name}:`, error);
      return false;
    }
  }

  /**
   * 执行健康检查的具体实现
   * 子类需要实现此方法
   */
  protected abstract performHealthCheck(): Promise<boolean>;

  /**
   * 发送HTTP请求的通用方法
   * @param path - 请求路径
   * @param options - 请求选项
   * @returns 响应数据
   */
  protected async request<ResType>(
    path: string,
    options: RequestInit = {}
  ): Promise<ExternalServiceResponse<ResType>> {
    const startTime = Date.now();
    
    // 构建带版本号的URL
    const versionPath = this.config.version ? `/${this.config.version}` : '';
    const url = `${this.config.baseUrl}${versionPath}${path}`;

    try {
      // 使用AbortController实现超时功能
      const controller = new AbortController();
      const signal = controller.signal;
      
      // 设置超时
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.config.timeout);

      // 构建完整的请求配置
      const requestConfig: RequestInit = {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
          ...options.headers,
        },
        signal,
        ...options,
      };

      // 发送请求
      const response = await fetch(url, requestConfig);
      
      // 清除超时定时器
      clearTimeout(timeoutId);
      
      const latency = Date.now() - startTime;

      // 解析响应
      const data = await this.parseResponse<ResType>(response);

      return {
        success: true,
        data,
        provider: this.name,
        latency,
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      const serviceError = this.createServiceError(error);

      return {
        success: false,
        error: serviceError,
        provider: this.name,
        latency,
      };
    }
  }

  /**
   * 解析响应数据
   * @param response - HTTP响应对象
   * @returns 解析后的数据
   */
  protected async parseResponse<ResType>(response: Response): Promise<ResType> {
    if (!response.ok) {
      // 处理非200状态码
      let errorData: ServiceErrorLike;
      try {
        const parsed = await response.json();
        errorData = isServiceErrorLike(parsed) ? parsed : {};
      } catch {
        errorData = { message: response.statusText };
      }

      throw {
        status: response.status,
        message: errorData.message || `HTTP Error ${response.status}`,
        code: errorData.code || `HTTP_${response.status}`,
      };
    }

    // 处理204 No Content
    if (response.status === 204) {
      return {} as ResType;
    }

    return response.json();
  }

  /**
   * 创建服务错误对象
   * @param error - 原始错误
   * @returns 标准化的服务错误
   */
  protected createServiceError(error: unknown): ExternalServiceError {
    if (error instanceof Error) {
      // 网络错误或其他错误
      return {
        code: 'NETWORK_ERROR',
        message: error.message,
        provider: this.name,
      };
    }

    // HTTP错误
    const serviceError = isServiceErrorLike(error) ? error : {};
    return {
      code: serviceError.code || 'UNKNOWN_ERROR',
      message: serviceError.message || 'An unknown error occurred',
      provider: this.name,
      status: serviceError.status,
    };
  }

  /**
   * 格式化请求URL，添加查询参数
   * @param path - 基础路径
   * @param params - 查询参数
   * @returns 格式化后的URL
   */
  protected formatUrl(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): string {
    const queryParams = new URLSearchParams();
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });

    const queryString = queryParams.toString();
    return queryString ? `${path}?${queryString}` : path;
  }
}
