// @/services/websocket.ts

import { WsMessage, OrderBookUpdate, TradeUpdate } from '@/types/orderBook';

/**
 * WebSocket服务类
 * @description 负责管理WebSocket连接，处理消息订阅和推送，实现自动重连等功能
 * @example
 * // 创建实例
 * const wsService = new WebSocketService('wss://api.example.com/ws');
 * // 连接并订阅
 * wsService.connect();
 * wsService.subscribe('AAPL/USDT');
 * // 监听消息
 * wsService.on('orderbook', (update) => {
 *   console.log('订单簿更新:', update);
 * });
 */
class WebSocketService {
  /** WebSocket实例 */
  private ws: WebSocket | null = null;
  /** WebSocket服务器URL */
  private url: string;
  /** 重连间隔时间（毫秒） */
  private reconnectInterval: number = 5000;
  /** 当前重连尝试次数 */
  private reconnectAttempts: number = 0;
  /** 最大重连尝试次数 */
  private maxReconnectAttempts: number = 5;
  /** 事件监听器映射表 */
  private listeners: Map<string, Function[]> = new Map();

  /**
   * 构造函数
   * @param url WebSocket服务器URL
   */
  constructor(url: string) {
    this.url = url;
  }

  /**
   * 连接WebSocket服务器
   * @description 建立WebSocket连接，设置事件处理器
   * @returns {void}
   */
  connect(): void {
    try {
      // 创建WebSocket实例
      this.ws = new WebSocket(this.url);
      // 设置事件处理器
      this.setupEventHandlers();
    } catch (error) {
      console.error('WebSocket连接失败:', error);
      // 连接失败时，安排重连
      this.scheduleReconnect();
    }
  }

  /**
   * 设置WebSocket事件处理器
   * @description 处理WebSocket的open、message、error、close事件
   * @private
   * @returns {void}
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    /**
     * WebSocket连接打开事件
     * @description 连接成功后，重置重连计数
     */
    this.ws.onopen = () => {
      console.log('WebSocket连接已建立');
      // 重置重连尝试次数
      this.reconnectAttempts = 0;
      // 连接成功后，可以在这里发送认证信息或初始订阅请求
    };

    /**
     * WebSocket消息接收事件
     * @description 接收并处理服务器推送的消息
     * @param {MessageEvent} event 消息事件对象
     */
    this.ws.onmessage = (event) => {
      try {
        // 解析JSON格式的消息
        const message: WsMessage = JSON.parse(event.data);
        // 处理消息
        this.handleMessage(message);
      } catch (error) {
        console.error('WebSocket消息解析错误:', error);
      }
    };

    /**
     * WebSocket错误事件
     * @description 处理WebSocket连接错误
     * @param {Event} error 错误事件对象
     */
    this.ws.onerror = (error) => {
      console.error('WebSocket错误:', error);
    };

    /**
     * WebSocket连接关闭事件
     * @description 连接关闭后，安排重连
     */
    this.ws.onclose = () => {
      console.log('WebSocket连接已关闭');
      // 连接关闭时，安排重连
      this.scheduleReconnect();
    };
  }

  /**
   * 处理WebSocket消息
   * @description 根据消息类型，分发给对应的事件监听器
   * @private
   * @param {WsMessage} message WebSocket消息对象
   * @returns {void}
   */
  private handleMessage(message: WsMessage): void {
    // 根据消息类型分发事件
    switch (message.type) {
      case 'orderbook':
        // 订单簿更新消息，分发给orderbook事件监听器
        this.emit('orderbook', message.data as OrderBookUpdate);
        break;
      case 'trade':
        // 成交记录消息，分发给trade事件监听器
        this.emit('trade', message.data as TradeUpdate);
        break;
      case 'market_summary':
        // 市场摘要消息，分发给market_summary事件监听器
        this.emit('market_summary', message.data);
        break;
      case 'error':
        // 错误消息，分发给error事件监听器
        this.emit('error', message.data);
        break;
      default:
        // 未知消息类型，记录警告日志
        console.warn('未知的WebSocket消息类型:', message.type);
    }
  }

  /**
   * 订阅事件
   * @description 添加事件监听器
   * @param {string} event 事件名称
   * @param {Function} callback 事件处理函数
   * @returns {void}
   */
  on(event: string, callback: Function): void {
    // 如果事件类型不存在，创建新的监听器数组
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    // 添加监听器到数组
    this.listeners.get(event)?.push(callback);
  }

  /**
   * 取消订阅事件
   * @description 移除指定事件的监听器
   * @param {string} event 事件名称
   * @param {Function} callback 事件处理函数
   * @returns {void}
   */
  off(event: string, callback: Function): void {
    // 如果事件类型存在
    if (this.listeners.has(event)) {
      // 过滤掉要移除的监听器
      const callbacks = this.listeners.get(event)?.filter(cb => cb !== callback);
      if (callbacks?.length) {
        // 如果还有剩余监听器，更新监听器数组
        this.listeners.set(event, callbacks);
      } else {
        // 如果没有剩余监听器，移除事件类型
        this.listeners.delete(event);
      }
    }
  }

  /**
   * 触发事件
   * @description 执行指定事件的所有监听器
   * @private
   * @param {string} event 事件名称
   * @param {any} data 事件数据
   * @returns {void}
   */
  private emit(event: string, data: any): void {
    // 获取事件的所有监听器
    this.listeners.get(event)?.forEach(callback => {
      try {
        // 执行监听器函数
        callback(data);
      } catch (error) {
        // 监听器执行错误时，记录日志，不影响其他监听器
        console.error('事件处理器执行错误:', error);
      }
    });
  }

  /**
   * 发送消息到服务器
   * @description 向WebSocket服务器发送JSON格式的消息
   * @param {any} data 要发送的数据
   * @returns {void}
   */
  send(data: any): void {
    // 检查WebSocket实例是否存在且状态为OPEN
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // 发送JSON格式的消息
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * 订阅交易对
   * @description 订阅指定交易对的订单簿和成交记录
   * @param {string} symbol 交易对（如：AAPL/USDT）
   * @returns {void}
   */
  subscribe(symbol: string): void {
    // 发送订阅请求
    this.send({
      type: 'subscribe',
      channels: [
        `orderbook_${symbol}`,  // 订单簿频道
        `trade_${symbol}`        // 成交记录频道
      ]
    });
  }

  /**
   * 取消订阅交易对
   * @description 取消订阅指定交易对的订单簿和成交记录
   * @param {string} symbol 交易对（如：AAPL/USDT）
   * @returns {void}
   */
  unsubscribe(symbol: string): void {
    // 发送取消订阅请求
    this.send({
      type: 'unsubscribe',
      channels: [
        `orderbook_${symbol}`,  // 订单簿频道
        `trade_${symbol}`        // 成交记录频道
      ]
    });
  }

  /**
   * 安排重连
   * @description 在指定时间后尝试重新连接WebSocket服务器
   * @private
   * @returns {void}
   */
  private scheduleReconnect(): void {
    // 检查是否达到最大重连尝试次数
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      // 增加重连尝试次数
      this.reconnectAttempts++;
      console.log(`尝试第 ${this.reconnectAttempts} 次重连...`);
      // 延迟指定时间后，执行重连
      setTimeout(() => {
        this.connect();
      }, this.reconnectInterval);
    } else {
      // 达到最大重连尝试次数，记录错误日志
      console.error('WebSocket重连失败，已达到最大尝试次数');
    }
  }

  /**
   * 关闭WebSocket连接
   * @description 主动关闭WebSocket连接
   * @returns {void}
   */
  close(): void {
    if (this.ws) {
      // 关闭WebSocket连接
      this.ws.close(1000, 'client disconnect');
      // 清空WebSocket实例
      this.ws = null;
    }
  }
}

/**
 * WebSocket服务单例实例
 * @description 全局共享的WebSocket服务实例，方便组件间共享连接
 */
export const wsService = new WebSocketService('wss://api.example.com/ws');
