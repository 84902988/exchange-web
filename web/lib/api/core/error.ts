export class ApiError extends Error {
  code: string;
  trace_id: string;
  originalError?: Error;
  data?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    trace_id: string,
    originalError?: Error,
    data?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.trace_id = trace_id;
    this.originalError = originalError;
    this.data = data;
  }

  getDetailedMessage(): string {
    return `${this.message} (Code: ${this.code}, Trace ID: ${this.trace_id})`;
  }
}
