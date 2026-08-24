import {ApiClientError, apiClient} from './client';
import type {Translator} from '../i18n';

export type KycLevelCode = 'PRIMARY' | 'ADVANCED';
export type KycIdType = 'PASSPORT' | 'ID_CARD' | 'DRIVER_LICENSE';
export type KycReviewStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';

export type KycSubmission = {
  id: number;
  kycLevel: KycLevelCode;
  fullName: string;
  countryCode: string;
  idType: KycIdType;
  idNumber: string;
  frontImageUrl: string;
  backImageUrl: string | null;
  selfieImageUrl: string;
  reviewStatus: KycReviewStatus;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MyKyc = {
  kycStatus: KycReviewStatus;
  kycLevel: number;
  latestSubmission: KycSubmission | null;
};

export type KycImageFile = {
  uri: string;
  name: string;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  fileSize: number | null;
};

export type SubmitKycPayload = {
  kycLevel: KycLevelCode;
  fullName: string;
  countryCode: string;
  idType: KycIdType;
  idNumber: string;
  frontImage: KycImageFile;
  backImage: KycImageFile | null;
  selfieImage: KycImageFile;
};

const KYC_UPLOAD_TIMEOUT_MS = 45_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalText(value: unknown) {
  const text = readText(value);
  return text || null;
}

function readPositiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normalizeStatus(
  value: unknown,
  allowNone: boolean,
): KycReviewStatus | null {
  const status = readText(value).toUpperCase();
  if (
    status === 'PENDING' ||
    status === 'APPROVED' ||
    status === 'REJECTED'
  ) {
    return status;
  }
  return allowNone && status === 'NONE' ? 'NONE' : null;
}

function normalizeLevel(value: unknown): KycLevelCode | null {
  const level = readText(value).toUpperCase();
  return level === 'PRIMARY' || level === 'ADVANCED' ? level : null;
}

function normalizeIdType(value: unknown): KycIdType | null {
  const idType = readText(value).toUpperCase();
  return idType === 'PASSPORT' ||
    idType === 'ID_CARD' ||
    idType === 'DRIVER_LICENSE'
    ? idType
    : null;
}

export function normalizeKycSubmission(value: unknown): KycSubmission {
  const root = isRecord(value) ? value : {};
  const id = readPositiveInteger(root.id);
  const kycLevel = normalizeLevel(root.kyc_level);
  const idType = normalizeIdType(root.id_type);
  const fullName = readText(root.full_name);
  const countryCode = readText(root.country_code).toUpperCase();
  const idNumber = readText(root.id_number);
  const frontImageUrl = readText(root.front_image_url);
  const selfieImageUrl = readText(root.selfie_image_url);
  const reviewStatus = normalizeStatus(root.review_status, false);

  if (
    id === null ||
    kycLevel === null ||
    idType === null ||
    !fullName ||
    !countryCode ||
    !idNumber ||
    !frontImageUrl ||
    !selfieImageUrl ||
    reviewStatus === null
  ) {
    throw new ApiClientError(
      'KYC 响应格式无效，请稍后重试',
      'INVALID_KYC_RESPONSE',
    );
  }

  return {
    id,
    kycLevel,
    fullName,
    countryCode,
    idType,
    idNumber,
    frontImageUrl,
    backImageUrl: readOptionalText(root.back_image_url),
    selfieImageUrl,
    reviewStatus,
    reviewNote: readOptionalText(root.review_note),
    reviewedAt: readOptionalText(root.reviewed_at),
    createdAt: readOptionalText(root.created_at),
    updatedAt: readOptionalText(root.updated_at),
  };
}

export function normalizeMyKyc(value: unknown): MyKyc {
  const root = isRecord(value) ? value : {};
  const rawLevel = root.kyc_level;
  const kycLevel =
    typeof rawLevel === 'number' &&
    Number.isSafeInteger(rawLevel) &&
    rawLevel >= 0 &&
    rawLevel <= 2
      ? rawLevel
      : null;
  if (kycLevel === null) {
    throw new ApiClientError(
      'KYC 响应格式无效，请稍后重试',
      'INVALID_KYC_RESPONSE',
    );
  }
  const kycStatus = normalizeStatus(root.kyc_status, true);
  if (kycStatus === null) {
    throw new ApiClientError(
      'KYC 响应格式无效，请稍后重试',
      'INVALID_KYC_RESPONSE',
    );
  }

  return {
    kycStatus,
    kycLevel,
    latestSubmission:
      root.latest_submission === null || root.latest_submission === undefined
        ? null
        : normalizeKycSubmission(root.latest_submission),
  };
}

function appendImage(formData: FormData, field: string, file: KycImageFile) {
  formData.append(
    field,
    {
      uri: file.uri,
      name: file.name,
      type: file.type,
    } as unknown as Blob,
  );
}

export async function fetchMyKyc(signal?: AbortSignal): Promise<MyKyc> {
  const payload = await apiClient.get<unknown>('/me/kyc', {signal});
  return normalizeMyKyc(payload);
}

export async function submitMyKyc(
  payload: SubmitKycPayload,
): Promise<KycSubmission> {
  const formData = new FormData();
  formData.append('kyc_level', payload.kycLevel);
  formData.append('full_name', payload.fullName.trim());
  formData.append('country_code', payload.countryCode.trim().toUpperCase());
  formData.append('id_type', payload.idType);
  formData.append('id_number', payload.idNumber.trim());
  appendImage(formData, 'front_image', payload.frontImage);
  if (payload.backImage) appendImage(formData, 'back_image', payload.backImage);
  appendImage(formData, 'selfie_image', payload.selfieImage);

  const response = await apiClient.post<unknown>('/me/kyc/submit', formData, {
    retry: 'none',
    timeoutMs: KYC_UPLOAD_TIMEOUT_MS,
  });
  const root = isRecord(response) ? response : {};
  return normalizeKycSubmission(root.submission);
}

export function getKycErrorMessage(error: unknown, t?: Translator) {
  const code =
    error instanceof ApiClientError ? error.code.trim().toUpperCase() : '';
  const messages: Record<string, string> = {
    KYC_PENDING_EXISTS:
      t?.('kyc.errorPending') || '认证材料正在审核中，请勿重复提交。',
    KYC_LEVEL_APPROVED:
      t?.('kyc.errorApproved') || '当前认证等级已经通过，无需重复提交。',
    INVALID_KYC_LEVEL:
      t?.('kyc.errorInvalidLevel') || '认证等级无效，请刷新后重试。',
    INVALID_ID_TYPE:
      t?.('kyc.errorInvalidIdType') || '证件类型无效，请重新选择。',
    INVALID_IMAGE:
      t?.('kyc.errorInvalidImage') || '仅支持 JPG、PNG 或 WebP 图片。',
    IMAGE_REQUIRED:
      t?.('kyc.errorImageRequired') || '请上传证件正面照片。',
    KYC_BACK_IMAGE_REQUIRED:
      t?.('kyc.errorBackRequired') || '当前证件类型需要上传背面照片。',
    KYC_SELFIE_IMAGE_REQUIRED:
      t?.('kyc.errorSelfieRequired') || '请上传本人手持证件或自拍照片。',
    IMAGE_TOO_LARGE:
      t?.('kyc.errorImageTooLarge') || '上传图片过大，请重新选择或拍照。',
    IMAGE_DIMENSIONS_INVALID:
      t?.('kyc.errorDimensions') || '图片尺寸过大，请重新选择或拍照。',
    VALIDATION_ERROR:
      t?.('kyc.errorValidation') || '请完整填写身份信息。',
    INVALID_KYC_RESPONSE:
      t?.('kyc.errorInvalidResponse') || 'KYC 数据格式异常，请稍后重试。',
    AUTH_REFRESHED_RETRY_REQUIRED:
      t?.('kyc.errorAuthRefreshed') ||
      '登录状态刚刚更新，请确认资料后重新提交。',
  };
  return messages[code] ||
    (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
      ? error.message
      : t?.('kyc.errorFallback') || 'KYC 操作失败，请稍后重试。');
}
