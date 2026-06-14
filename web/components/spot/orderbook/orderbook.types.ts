export type DepthItem = {
  price: string
  amount: string
}

export type SpotDepthResponse = {
  asks: DepthItem[]
  bids: DepthItem[]
}

export type OrderBookRow = {
  price: number
  amount: number
  total: number
}

export type OrderBookRowData = OrderBookRow & {
  percent?: number
}
