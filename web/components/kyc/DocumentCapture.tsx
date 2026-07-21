'use client';

import { useState, useRef, useEffect, ChangeEvent } from 'react';
import { DocumentVerificationResult, KycDocumentUploadRequest } from '@/lib/api';
import { kycService } from '@/lib/services/kycService';
import { useLocaleContext } from '@/contexts/LocaleContext';

interface DocumentCaptureProps {
  applicationId: string;
  countryCode?: string;
  onDocumentVerified: (result: DocumentVerificationResult) => void;
  onError: (error: unknown) => void;
}

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

function getDocumentTypeLabel(
  type: KycDocumentUploadRequest['document_type'],
  fallback: string,
  t: (key: string, namespace?: 'user') => string,
): string {
  if (type === 'passport') return t('kycIdTypePassport', 'user');
  if (type === 'id_card') return t('kycIdTypeIdCard', 'user');
  if (type === 'driver_license') return t('kycIdTypeDriverLicense', 'user');
  return fallback;
}

export default function DocumentCapture({
  applicationId,
  countryCode,
  onDocumentVerified,
  onError,
}: DocumentCaptureProps) {
  const { t } = useLocaleContext();
  const [selectedDocumentType, setSelectedDocumentType] = useState<KycDocumentUploadRequest['document_type']>('passport');
  const [currentSide, setCurrentSide] = useState<'front' | 'back'>('front');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentPreview, setDocumentPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [qualityScore, setQualityScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const supportedDocumentTypes = kycService.getSupportedDocumentTypes(countryCode);
  const requiresBackSide = supportedDocumentTypes.find((type) => type.type === selectedDocumentType)?.requiresBackSide || false;

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (!file.type.startsWith('image/')) {
        setError(t('kycCaptureSelectImageFile', 'user'));
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        setError(t('kycCaptureFileTooLarge', 'user'));
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      setDocumentPreview(previewUrl);
      setDocumentFile(file);
      setError(null);

      const score = await kycService.validateDocumentQuality(file);
      setQualityScore(score);

      if (score < 60) {
        setError(t('kycCaptureLowDocumentQuality', 'user'));
      }
    } catch (err) {
      setError(t('kycCaptureFileProcessFailed', 'user'));
      console.error('Document file processing failed:', err);
    }
  };

  const handleDocumentTypeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const type = e.target.value as KycDocumentUploadRequest['document_type'];
    setSelectedDocumentType(type);
    setCurrentSide('front');
    setDocumentFile(null);
    setDocumentPreview(null);
    setQualityScore(null);
    setError(null);
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setShowCamera(false);
  };

  const toggleCamera = async () => {
    if (showCamera) {
      stopCamera();
      return;
    }

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setShowCamera(true);
      setError(null);
    } catch (err) {
      setError(t('kycCaptureCameraAccessFailed', 'user'));
      console.error('Camera access failed:', err);
      stopCamera();
    }
  };

  useEffect(() => {
    if (!showCamera || !videoRef.current || !streamRef.current) return;

    const video = videoRef.current;
    video.srcObject = streamRef.current;
    void video.play().catch((err) => {
      console.error('Camera playback failed:', err);
      setError(t('kycCaptureCameraAccessFailed', 'user'));
      stopCamera();
    });
  }, [showCamera, t]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(async (blob) => {
      if (!blob) return;

      const file = new File([blob], `${selectedDocumentType}_${currentSide}.jpg`, { type: 'image/jpeg' });
      const previewUrl = canvas.toDataURL('image/jpeg');
      setDocumentPreview(previewUrl);
      setDocumentFile(file);

      const score = await kycService.validateDocumentQuality(file);
      setQualityScore(score);

      if (score < 60) {
        setError(t('kycCaptureLowPhotoQuality', 'user'));
      } else {
        setError(null);
      }

      stopCamera();
    }, 'image/jpeg', 0.9);
  };

  const handleVerify = async () => {
    if (!documentFile) {
      setError(t('kycCaptureSelectDocumentFirst', 'user'));
      return;
    }

    if (qualityScore && qualityScore < 60) {
      setError(t('kycCaptureLowDocumentQuality', 'user'));
      return;
    }

    try {
      setIsUploading(true);
      setError(null);

      const result = await kycService.verifyDocument({
        application_id: applicationId,
        document_type: selectedDocumentType,
        file: documentFile,
        file_side: currentSide,
        country_code: countryCode,
      });

      onDocumentVerified(result);

      if (requiresBackSide && currentSide === 'front') {
        setCurrentSide('back');
        setDocumentFile(null);
        setDocumentPreview(null);
        setQualityScore(null);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('kycCaptureVerifyDocumentFailed', 'user');
      setError(errorMessage);
      onError(err);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="kyc-document-type" className="block text-sm font-medium text-white mb-2">
          {t('kycCaptureDocumentType', 'user')}
        </label>
        <select
          id="kyc-document-type"
          value={selectedDocumentType}
          onChange={handleDocumentTypeChange}
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {supportedDocumentTypes.map((type) => (
            <option key={type.type} value={type.type}>
              {getDocumentTypeLabel(type.type, type.name, t)}
            </option>
          ))}
        </select>
      </div>

      {requiresBackSide && (
        <div className="text-sm text-white/70">
          {formatTemplate(t('kycCaptureCurrentSide', 'user'), {
            side: currentSide === 'front' ? t('kycCaptureFront', 'user') : t('kycCaptureBack', 'user'),
          })}
        </div>
      )}

      {error && (
        <div className="bg-red-500/20 text-red-400 p-3 rounded-md">
          {error}
        </div>
      )}

      <div className="border-2 border-dashed border-gray-700 rounded-lg p-6 text-center">
        {documentPreview ? (
          <div className="space-y-4">
            <img
              src={documentPreview}
              alt={t('kycSubmitSectionTitle', 'user')}
              className="max-w-full h-auto max-h-64 mx-auto rounded-md"
            />
            {qualityScore !== null && (
              <div className="text-sm">
                {formatTemplate(t('kycCaptureDocumentQuality', 'user'), { score: qualityScore })}
                <div className="w-full bg-gray-700 rounded-full h-2 mt-1">
                  <div
                    className={`h-2 rounded-full ${qualityScore >= 80 ? 'bg-green-500' : qualityScore >= 60 ? 'bg-yellow-500' : 'bg-red-500'}`}
                    style={{ width: `${qualityScore}%` }}
                  ></div>
                </div>
              </div>
            )}
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDocumentFile(null);
                  setDocumentPreview(null);
                  setQualityScore(null);
                  setError(null);
                }}
                className="px-4 py-2 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors"
              >
                {t('kycCaptureReselect', 'user')}
              </button>
              <button
                type="button"
                onClick={handleVerify}
                disabled={isUploading || (qualityScore !== null && qualityScore < 60)}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed"
              >
                {isUploading ? t('kycCaptureVerifying', 'user') : t('kycCaptureVerifyDocument', 'user')}
              </button>
            </div>
          </div>
        ) : showCamera ? (
          <div className="space-y-4">
            <div className="relative">
              <video
                ref={videoRef}
                className="max-w-full h-auto max-h-64 mx-auto rounded-md"
                autoPlay
                playsInline
              ></video>
              <canvas ref={canvasRef} className="hidden"></canvas>
            </div>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={toggleCamera}
                className="px-4 py-2 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors"
              >
                {t('kycCaptureCancel', 'user')}
              </button>
              <button
                type="button"
                onClick={capturePhoto}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                {t('kycCaptureTakePhoto', 'user')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-white/70">{t('kycCaptureUploadOrCaptureDocument', 'user')}</p>
            <div className="flex justify-center gap-4">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-6 py-3 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                {t('kycCaptureChooseFile', 'user')}
              </button>
              <button
                type="button"
                onClick={toggleCamera}
                className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t('kycCaptureTakePhoto', 'user')}
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              aria-label={t('kycCaptureChooseFile', 'user')}
              onChange={handleFileChange}
              className="hidden"
            />
          </div>
        )}
      </div>
    </div>
  );
}
