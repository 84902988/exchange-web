import { request } from "../core/request";

export type KycLevelCode = "PRIMARY" | "ADVANCED";
export type KycIdType = "PASSPORT" | "ID_CARD" | "DRIVER_LICENSE";
export type KycReviewStatus = "PENDING" | "APPROVED" | "REJECTED" | "NONE" | string;

export interface KycSubmissionV1 {
  id: number;
  user_id: number;
  kyc_level: KycLevelCode | string;
  full_name: string;
  country_code: string;
  id_type: KycIdType | string;
  id_number: string;
  front_image_url: string;
  back_image_url?: string | null;
  selfie_image_url?: string | null;
  review_status: KycReviewStatus;
  review_note?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MyKycResponse {
  kyc_status: KycReviewStatus;
  kyc_level: number;
  latest_submission: KycSubmissionV1 | null;
}

export interface SubmitMyKycPayload {
  kycLevel: KycLevelCode;
  fullName: string;
  countryCode: string;
  idType: KycIdType;
  idNumber: string;
  frontImage: File;
  backImage?: File | null;
  selfieImage?: File | null;
}

export const getMyKyc = (): Promise<MyKycResponse> => {
  return request<MyKycResponse>("/me/kyc", { method: "GET" });
};

export const submitMyKyc = (payload: SubmitMyKycPayload): Promise<{ submission: KycSubmissionV1 }> => {
  const formData = new FormData();
  formData.append("kyc_level", payload.kycLevel);
  formData.append("full_name", payload.fullName);
  formData.append("country_code", payload.countryCode);
  formData.append("id_type", payload.idType);
  formData.append("id_number", payload.idNumber);
  formData.append("front_image", payload.frontImage);
  if (payload.backImage) formData.append("back_image", payload.backImage);
  if (payload.selfieImage) formData.append("selfie_image", payload.selfieImage);

  return request<{ submission: KycSubmissionV1 }>("/me/kyc/submit", {
    method: "POST",
    body: formData,
  });
};

export interface KycStatus {
  kyc_level: number;
  kyc_status: "pending" | "under_review" | "approved" | "rejected" | "expired";
  verified_at?: string;
  expires_at?: string;
  required_documents: Array<{ type: string; status: string; uploaded_at?: string }>;
}

export interface KycApplication {
  application_id: string;
  status: "pending" | "under_review" | "approved" | "rejected";
  required_documents: string[];
}

export interface KycApplyRequest {
  level: number;
  personal_info: {
    first_name: string;
    last_name: string;
    dob: string;
    nationality: string;
    address: {
      street: string;
      city: string;
      state?: string;
      country: string;
      postal_code: string;
    };
  };
}

export interface KycDocumentUploadRequest {
  application_id: string;
  document_type:
    | "id_card"
    | "passport"
    | "driver_license"
    | "utility_bill"
    | "residence_permit"
    | "national_id"
    | "military_id"
    | "student_id";
  file: File;
  file_side?: "front" | "back";
  country_code?: string;
}

export interface FaceVerificationRequest {
  application_id: string;
  face_image: File;
  liveness_data?: Record<string, unknown>;
}

export interface FaceVerificationResult {
  success: boolean;
  confidence_score: number;
  liveness_detected: boolean;
  message?: string;
  face_id?: string;
}

export interface DocumentVerificationResult {
  success: boolean;
  document_type: string;
  country: string;
  extracted_data: {
    first_name: string;
    last_name: string;
    date_of_birth: string;
    document_number: string;
    expiry_date?: string;
    nationality?: string;
  };
  image_quality: number;
  tampering_detected: boolean;
  message?: string;
  document_id?: string;
}

export interface KycVerificationResult {
  application_id: string;
  overall_status: "pending" | "approved" | "rejected" | "review_required";
  document_verification: DocumentVerificationResult;
  face_verification?: FaceVerificationResult;
  submission_date: string;
  review_date?: string;
  rejection_reason?: string;
  kyc_level: number;
}

export interface KycResult {
  application_id: string;
  kyc_level: number;
  status: "approved" | "rejected";
  approved_at?: string;
  expires_at?: string;
  documents: Array<{ document_id: string; document_type: string; status: string; file_url: string }>;
  rejection_reason?: string;
}

export interface KycUpdateRequest {
  personal_info?: {
    address: {
      street: string;
      city: string;
      state?: string;
      country: string;
      postal_code: string;
    };
  };
}

// ✅ 获取 KYC 状态
export const getKycStatus = (): Promise<KycStatus> => {
  return request<KycStatus>("/api/v1/user/kyc/status", { method: "GET" });
};

// ✅ 申请 KYC
export const applyKyc = (data: KycApplyRequest): Promise<KycApplication> => {
  return request<KycApplication>("/api/v1/user/kyc/apply", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ✅ 上传 KYC 文件
export const uploadKycDocument = (
  application_id: string,
  document_type: KycDocumentUploadRequest["document_type"],
  file: File,
  file_side?: KycDocumentUploadRequest["file_side"]
): Promise<{ document_id: string; status: string; file_url: string; uploaded_at: string }> => {
  const formData = new FormData();
  formData.append("application_id", application_id);
  formData.append("document_type", document_type);
  formData.append("file", file);
  if (file_side) formData.append("file_side", file_side);

  return request<{ document_id: string; status: string; file_url: string; uploaded_at: string }>(
    "/api/v1/user/kyc/upload-document",
    {
      method: "POST",
      body: formData,
      // 不要设置 headers，让浏览器自动生成 multipart boundary
    }
  );
};

// ✅ 获取 KYC 结果
export const getKycResult = (application_id: string): Promise<KycResult> => {
  const qs = new URLSearchParams({ application_id }).toString();
  return request<KycResult>(`/api/v1/user/kyc/result?${qs}`, { method: "GET" });
};

// ✅ 更新 KYC 信息
export const updateKycInfo = (data: KycUpdateRequest): Promise<{ success: boolean; updated_fields: string[] }> => {
  return request<{ success: boolean; updated_fields: string[] }>("/api/v1/user/kyc/update", {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

// ✅ 人脸验证（FormData）
export const verifyFace = (data: FaceVerificationRequest): Promise<FaceVerificationResult> => {
  const formData = new FormData();
  formData.append("application_id", data.application_id);
  formData.append("face_image", data.face_image);
  if (data.liveness_data) formData.append("liveness_data", JSON.stringify(data.liveness_data));

  return request<FaceVerificationResult>("/api/v1/user/kyc/verify-face", {
    method: "POST",
    body: formData,
  });
};

// ✅ 证件验证（FormData）
export const verifyDocument = (data: KycDocumentUploadRequest): Promise<DocumentVerificationResult> => {
  const formData = new FormData();
  formData.append("application_id", data.application_id);
  formData.append("document_type", data.document_type);
  formData.append("file", data.file);
  if (data.file_side) formData.append("file_side", data.file_side);
  if (data.country_code) formData.append("country_code", data.country_code);

  return request<DocumentVerificationResult>("/api/v1/user/kyc/verify-document", {
    method: "POST",
    body: formData,
  });
};

// ✅ 获取 KYC 审核详情/验证结果
export const getKycVerificationResult = (application_id: string): Promise<KycVerificationResult> => {
  const qs = new URLSearchParams({ application_id }).toString();
  return request<KycVerificationResult>(`/api/v1/user/kyc/verification-result?${qs}`, { method: "GET" });
};
