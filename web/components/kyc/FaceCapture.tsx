'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { kycService } from '@/lib/services/kycService';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { FaceVerificationResult } from '@/lib/api';

interface FaceCaptureProps {
  applicationId: string;
  onFaceVerified: (result: FaceVerificationResult) => void;
  onError: (error: unknown) => void;
}

export default function FaceCapture({
  applicationId,
  onFaceVerified,
  onError,
}: FaceCaptureProps) {
  const { t } = useLocaleContext();
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [facePreview, setFacePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [livenessStep, setLivenessStep] = useState<number>(0);
  const [livenessCompleted, setLivenessCompleted] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const livenessSteps = useMemo(() => [
    t('kycCaptureLookAtCamera', 'user'),
    t('kycCaptureBlinkSlowly', 'user'),
    t('kycCaptureShakeHeadSlowly', 'user'),
    t('kycCaptureSmile', 'user'),
  ], [t]);

  const currentInstruction = livenessCompleted
    ? t('kycCaptureLivenessCompleted', 'user')
    : livenessSteps[livenessStep] || t('kycCaptureFaceInitialInstruction', 'user');

  const initCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setIsCameraActive(true);
        setError(null);
      }
    } catch (err) {
      setError(t('kycCaptureCameraAccessFailed', 'user'));
      console.error('Camera access failed:', err);
    }
  };

  const closeCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsCameraActive(false);
    setFacePreview(null);
    resetLiveness();
  };

  const resetLiveness = () => {
    setLivenessStep(0);
    setLivenessCompleted(false);
  };

  const startLiveness = () => {
    resetLiveness();
    setIsCapturing(true);
  };

  const nextLivenessStep = () => {
    if (livenessStep < livenessSteps.length - 1) {
      setLivenessStep((step) => step + 1);
    } else {
      setLivenessCompleted(true);
    }
  };

  const captureFace = () => {
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

      const file = new File([blob], 'face.jpg', { type: 'image/jpeg' });
      const previewUrl = canvas.toDataURL('image/jpeg');
      setFacePreview(previewUrl);

      const qualityScore = await kycService.validateDocumentQuality(file);

      if (qualityScore < 70) {
        setError(t('kycCaptureFaceQualityLow', 'user'));
        return;
      }

      try {
        setIsVerifying(true);
        setError(null);

        const result = await kycService.verifyFace({
          application_id: applicationId,
          face_image: file,
          liveness_data: {
            completed_steps: livenessSteps.length,
            timestamp: Date.now(),
          },
        });

        onFaceVerified(result);
        closeCamera();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t('kycCaptureVerifyFaceFailed', 'user');
        setError(errorMessage);
        onError(err);
      } finally {
        setIsVerifying(false);
        setIsCapturing(false);
      }
    }, 'image/jpeg', 0.9);
  };

  useEffect(() => {
    return () => {
      closeCamera();
    };
  }, []);

  useEffect(() => {
    let timer: NodeJS.Timeout;

    if (isCapturing && !livenessCompleted) {
      timer = setTimeout(() => {
        nextLivenessStep();
      }, 2000);
    }

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isCapturing, livenessCompleted, livenessStep]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-500/20 text-red-400 p-3 rounded-md">
          {error}
        </div>
      )}

      <div className="border-2 border-dashed border-gray-700 rounded-lg p-6 text-center">
        {facePreview ? (
          <div className="space-y-4">
            <img
              src={facePreview}
              alt={t('kycSelfieImage', 'user')}
              className="max-w-full h-auto max-h-64 mx-auto rounded-md"
            />
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setFacePreview(null);
                  setError(null);
                }}
                className="px-4 py-2 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors"
              >
                {t('kycCaptureRetake', 'user')}
              </button>
              <button
                type="button"
                onClick={captureFace}
                disabled={isVerifying}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-600 disabled:cursor-not-allowed"
              >
                {isVerifying ? t('kycCaptureVerifying', 'user') : t('kycCaptureVerifyFace', 'user')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {isCameraActive ? (
              <>
                <div className="relative mx-auto w-full max-w-md">
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-64 h-80 border-2 border-blue-500 rounded-full opacity-70"></div>
                    <div className="absolute bottom-4 left-0 right-0 text-center text-white font-medium">
                      {currentInstruction}
                    </div>
                  </div>

                  <video
                    ref={videoRef}
                    className="w-full h-auto rounded-md"
                    autoPlay
                    playsInline
                  ></video>
                  <canvas ref={canvasRef} className="hidden"></canvas>
                </div>

                <div className="flex justify-center gap-4">
                  {!isCapturing ? (
                    <button
                      type="button"
                      onClick={startLiveness}
                      className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    >
                      {t('kycCaptureStartLiveness', 'user')}
                    </button>
                  ) : livenessCompleted ? (
                    <button
                      type="button"
                      onClick={captureFace}
                      className="px-6 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                    >
                      {t('kycCaptureCaptureFace', 'user')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={nextLivenessStep}
                      className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    >
                      {t('kycCaptureNextStep', 'user')}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={closeCamera}
                    className="px-6 py-3 bg-gray-700 text-white rounded-md hover:bg-gray-600 transition-colors"
                  >
                    {t('kycCaptureCloseCamera', 'user')}
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-4">
                <div className="w-full h-64 bg-gray-800 rounded-md flex items-center justify-center">
                  <svg className="w-16 h-16 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <button
                  type="button"
                  onClick={initCamera}
                  className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                >
                  {t('kycCaptureOpenCamera', 'user')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="text-sm text-white/70">
        <p>- {t('kycCaptureFaceTipLighting', 'user')}</p>
        <p>- {t('kycCaptureFaceTipRemoveCover', 'user')}</p>
        <p>- {t('kycCaptureFaceTipCleanBackground', 'user')}</p>
      </div>
    </div>
  );
}
