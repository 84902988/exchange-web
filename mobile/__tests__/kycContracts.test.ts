import {
  getKycErrorMessage,
  normalizeKycSubmission,
  normalizeMyKyc,
  submitMyKyc,
} from '../src/api/kyc';
import {
  __resetApiClientForTests,
  ApiClientError,
  setApiAuthTokens,
} from '../src/api/client';
import {
  formatKycDate,
  getEffectiveStatus,
  maskKycId,
  normalizePickedImage,
  validateKycForm,
} from '../src/screens/account/KycScreen';
import {createTranslator} from '../src/i18n';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

const image = {
  uri: 'file:///tmp/kyc.jpg',
  name: 'kyc.jpg',
  type: 'image/jpeg' as const,
  fileSize: 120_000,
};

describe('mobile KYC contracts', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    __resetApiClientForTests();
    setApiAuthTokens({accessToken: 'access-kyc', refreshToken: 'refresh-kyc'});
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes authenticated KYC status and keeps review detail', () => {
    expect(
      normalizeMyKyc({
        kyc_status: 'REJECTED',
        kyc_level: 0,
        latest_submission: {
          id: 8,
          kyc_level: 'PRIMARY',
          full_name: 'Test User',
          country_code: 'cn',
          id_type: 'ID_CARD',
          id_number: '110101199001011234',
          front_image_url: '/me/kyc/submissions/8/materials/front',
          back_image_url: '/me/kyc/submissions/8/materials/back',
          selfie_image_url: '/me/kyc/submissions/8/materials/selfie',
          review_status: 'REJECTED',
          review_note: '证件照片反光',
          reviewed_at: '2026-08-01T11:00:00',
          created_at: '2026-08-01T10:00:00',
          updated_at: '2026-08-01T11:00:00',
        },
      }),
    ).toMatchObject({
      kycStatus: 'REJECTED',
      kycLevel: 0,
      latestSubmission: {
        id: 8,
        countryCode: 'CN',
        reviewStatus: 'REJECTED',
        reviewNote: '证件照片反光',
      },
    });
  });

  it('fails closed when the backend submission shape is incomplete', () => {
    expect(() => normalizeKycSubmission({id: 8})).toThrow(
      'KYC 响应格式无效',
    );
    expect(() => normalizeMyKyc({kyc_status: 'NONE', kyc_level: '0'})).toThrow(
      'KYC 响应格式无效',
    );
    expect(() =>
      normalizeMyKyc({kyc_status: 'UNKNOWN', kyc_level: 0}),
    ).toThrow('KYC 响应格式无效');
    expect(() =>
      normalizeKycSubmission({
        id: 8,
        kyc_level: 'PRIMARY',
        full_name: 'Test User',
        country_code: 'CN',
        id_type: 'PASSPORT',
        id_number: 'P1234567',
        front_image_url: '/front',
        selfie_image_url: '/selfie',
        review_status: 'UNKNOWN',
      }),
    ).toThrow('KYC 响应格式无效');
  });

  it('sends multipart data without forcing a JSON content type', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        data: {
          submission: {
            id: 9,
            kyc_level: 'PRIMARY',
            full_name: 'Test User',
            country_code: 'CN',
            id_type: 'PASSPORT',
            id_number: 'P1234567',
            front_image_url: '/me/kyc/submissions/9/materials/front',
            back_image_url: null,
            selfie_image_url: '/me/kyc/submissions/9/materials/selfie',
            review_status: 'PENDING',
          },
        },
      }),
    );

    await expect(
      submitMyKyc({
        kycLevel: 'PRIMARY',
        fullName: ' Test User ',
        countryCode: 'cn',
        idType: 'PASSPORT',
        idNumber: ' P1234567 ',
        frontImage: image,
        backImage: null,
        selfieImage: {...image, name: 'selfie.jpg'},
      }),
    ).resolves.toMatchObject({id: 9, reviewStatus: 'PENDING'});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer access-kyc',
    });
    expect(init.headers).not.toHaveProperty('Content-Type');
  });

  it('validates required document sides and the 2 MB mobile cap', () => {
    expect(
      validateKycForm({
        fullName: 'Test User',
        countryCode: 'CN',
        idNumber: '110101199001011234',
        idType: 'ID_CARD',
        frontImage: image,
        backImage: null,
        selfieImage: image,
      }),
    ).toBe('请上传证件背面照片。');
    expect(
      validateKycForm({
        fullName: 'Test User',
        countryCode: 'CN',
        idNumber: 'P1234567',
        idType: 'PASSPORT',
        frontImage: image,
        backImage: null,
        selfieImage: image,
      }),
    ).toBe('');
    expect(() =>
      normalizePickedImage(
        {
          uri: 'file:///tmp/large.jpg',
          type: 'image/jpeg',
          fileSize: 2 * 1024 * 1024 + 1,
        },
        'front',
      ),
    ).toThrow('单张图片不能超过 2 MB');
  });

  it('masks identifiers and uses the latest review state as authority', () => {
    expect(maskKycId('110101199001011234')).toBe('110**********1234');
    expect(
      getEffectiveStatus({
        kycStatus: 'APPROVED',
        kycLevel: 1,
        latestSubmission: {
          id: 8,
          kycLevel: 'PRIMARY',
          fullName: 'Test User',
          countryCode: 'CN',
          idType: 'ID_CARD',
          idNumber: '110101199001011234',
          frontImageUrl: '/front',
          backImageUrl: '/back',
          selfieImageUrl: '/selfie',
          reviewStatus: 'REJECTED',
          reviewNote: null,
          reviewedAt: null,
          createdAt: null,
          updatedAt: null,
        },
      }),
    ).toBe('REJECTED');
  });

  it('formats review timestamps without depending on Android locale support', () => {
    expect(formatKycDate('2026-08-02T16:37:00')).toBe('2026-08-02 16:37');
    expect(formatKycDate('not-a-date')).toBe('--');
    expect(formatKycDate(null)).toBe('--');
  });

  it('maps backend business codes without exposing raw technical messages', () => {
    expect(
      getKycErrorMessage(
        new ApiClientError('raw', 'KYC_PENDING_EXISTS', 400),
      ),
    ).toContain('正在审核');
    expect(getKycErrorMessage(new Error('SQLAlchemy traceback'))).toBe(
      'KYC 操作失败，请稍后重试。',
    );
    expect(
      getKycErrorMessage(
        new ApiClientError('raw', 'IMAGE_DIMENSIONS_INVALID', 400),
      ),
    ).toContain('尺寸过大');
  });

  it('localizes client validation and known business errors when a translator is supplied', () => {
    const t = createTranslator('en');
    expect(
      validateKycForm(
        {
          fullName: '',
          countryCode: 'CN',
          idNumber: '',
          idType: 'PASSPORT',
          frontImage: null,
          backImage: null,
          selfieImage: null,
        },
        t,
      ),
    ).toBe('Enter your legal name.');
    expect(() =>
      normalizePickedImage(
        {
          uri: 'file:///tmp/document.gif',
          type: 'image/gif',
          fileName: 'document.gif',
        },
        'front',
        t,
      ),
    ).toThrow('Only JPG, PNG or WebP images are supported.');
    expect(
      getKycErrorMessage(
        new ApiClientError('raw', 'KYC_PENDING_EXISTS', 400),
        t,
      ),
    ).toContain('under review');
  });
});
