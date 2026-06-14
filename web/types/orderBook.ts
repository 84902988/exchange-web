// @/types/orderBook.ts

/**
 * 订单数据类型
 * @description 用于表示订单簿中的单个订单，包含价格、数量和总金额
 */
export interface Order {
  /** 订单价格（字符串格式，便于直接显示） */
  price: string;
  /** 订单数量（字符串格式，便于直接显示） */
  amount: string;
  /** 订单总金额（字符串格式，便于直接显示） */
  total: string;
}

/**
 * 成交记录数据类型
 * @description 用于表示已成交的交易记录，包含时间、价格、数量和成交方向
 */
export interface TradeRecord {
  /** 成交时间（格式：HH:MM:SS） */
  time: string;
  /** 成交价格（字符串格式） */
  price: string;
  /** 成交数量（字符串格式） */
  amount: string;
  /** 成交方向（buy: 买入, sell: 卖出） */
  type: 'buy' | 'sell';
}

/**
 * WebSocket消息基础类型
 * @description 所有WebSocket消息的通用格式
 */
export interface WsMessage {
  /** 消息类型（orderbook: 订单簿更新, trade: 成交记录, market_summary: 市场摘要, error: 错误消息） */
  type: 'orderbook' | 'trade' | 'market_summary' | 'error';
  /** 消息数据（具体类型根据type字段确定） */
  data: any;
}

/**
 * 市场摘要消息
 * @description 包含多个交易对的最新行情数据
 */
export interface MarketSummaryUpdate {
  /** 市场摘要数据数组 */
  data: Array<{
    /** 交易对（如：ETH/USDT） */
    symbol: string;
    /** 最新价格（字符串格式） */
    price: string;
    /** 涨跌幅（带正负号，如：+0.32%） */
    change: string;
  }>;
}

/**
 * 订单簿更新消息
 * @description 当订单簿发生变化时，WebSocket推送的更新消息
 */
export interface OrderBookUpdate {
  /** 交易对（如：AAPL/USDT） */
  symbol: string;
  /** 买盘订单列表（按价格从高到低排序） */
  bids: Order[];
  /** 卖盘订单列表（按价格从低到高排序） */
  asks: Order[];
  /** 更新时间戳（毫秒） */
  timestamp: number;
}

/**
 * 成交记录消息
 * @description 当有新成交发生时，WebSocket推送的消息
 */
export interface TradeUpdate {
  /** 交易对（如：AAPL/USDT） */
  symbol: string;
  /** 成交记录详情 */
  trade: TradeRecord;
  /** 成交时间戳（毫秒） */
  timestamp: number;
}