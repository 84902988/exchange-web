import { request } from "../core/request";

export interface IdentityStep {
  id: number;
  title: string;
  description: string;
  status: 0 | 1 | 2; // 0: 未开始, 1: 进行中, 2: 已完成
  createdAt: string;
  updatedAt: string;
}

export interface IdentityStatus {
  isCompleted: boolean;
  steps: IdentityStep[];
  updatedAt: string;
}

// ✅ 获取身份认证状态
export const getIdentityStatus = (): Promise<IdentityStatus> => {
  return request<IdentityStatus>("/api/v1/user/identity/status", {
    method: "GET",
  });
};

// ✅ 提交某一步的认证信息
export const submitIdentityStep = <D = Record<string, unknown>>(
  stepId: number,
  data: D
): Promise<IdentityStatus> => {
  return request<IdentityStatus>(`/api/v1/user/identity/steps/${stepId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ✅ 上传认证文件（FormData）
export const uploadIdentityDocument = (
  stepId: number,
  file: File
): Promise<{ url: string; filename: string }> => {
  const formData = new FormData();
  formData.append("file", file);

  return request<{ url: string; filename: string }>(
    `/api/v1/user/identity/steps/${stepId}/upload`,
    {
      method: "POST",
      body: formData,
      // 不要手动设置 Content-Type，request.ts 会正确处理 FormData
    }
  );
};
