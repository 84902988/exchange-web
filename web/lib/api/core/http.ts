import { request } from "./request";

// GET
export const apiGet = <T>(path: string): Promise<T> => {
  return request<T>(path, { method: "GET" });
};

// POST JSON
export const apiPost = <T, B = unknown>(path: string, body: B): Promise<T> => {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
};

// PUT JSON
export const apiPut = <T, B = unknown>(path: string, body: B): Promise<T> => {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
};

// DELETE
export const apiDelete = <T>(path: string): Promise<T> => {
  return request<T>(path, { method: "DELETE" });
};
