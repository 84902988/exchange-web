// API响应类型定义
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data: T;
  error: null | {
    code: string;
    message: string;
  };
  trace_id: string;
}
