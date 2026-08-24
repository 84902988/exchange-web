import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Camera,
  CheckCircle2,
  Clock3,
  FileCheck2,
  ImagePlus,
  ShieldCheck,
  XCircle,
} from 'lucide-react-native';
import {
  launchCamera,
  launchImageLibrary,
  type Asset,
  type ImagePickerResponse,
} from 'react-native-image-picker';

import {
  fetchMyKyc,
  getKycErrorMessage,
  submitMyKyc,
  type KycIdType,
  type KycImageFile,
  type KycReviewStatus,
  type MyKyc,
} from '../../api/kyc';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  AuthRequiredCard,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SectionLabel,
  SelectChips,
  StateCard,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import { useLanguage, type Translator } from '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'Kyc'>;
type ImageSlot = 'front' | 'back' | 'selfie';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_OPTIONS = {
  mediaType: 'photo' as const,
  maxWidth: 1600,
  maxHeight: 1600,
  quality: 0.7 as const,
  selectionLimit: 1,
  includeBase64: false,
  includeExtra: false,
  assetRepresentationMode: 'compatible' as const,
};

export default function KycScreen() {
  const navigation = useNavigation<Navigation>();
  const { t } = useLanguage();
  const { isLoggedIn, restoreSession } = useAuth();
  const mountedRef = useRef(true);
  const pickerDialogOpenRef = useRef(false);
  const pickerLockRef = useRef(false);
  const submitConfirmationOpenRef = useRef(false);
  const submitLockRef = useRef(false);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadRequestIdRef = useRef(0);
  const [kyc, setKyc] = useState<MyKyc | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [fullName, setFullName] = useState('');
  const [countryCode, setCountryCode] = useState('CN');
  const [idType, setIdType] = useState<KycIdType>('ID_CARD');
  const [idNumber, setIdNumber] = useState('');
  const [frontImage, setFrontImage] = useState<KycImageFile | null>(null);
  const [backImage, setBackImage] = useState<KycImageFile | null>(null);
  const [selfieImage, setSelfieImage] = useState<KycImageFile | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pickerDialogOpenRef.current = false;
      pickerLockRef.current = false;
      submitConfirmationOpenRef.current = false;
      loadAbortRef.current?.abort();
    };
  }, []);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    if (!isLoggedIn) {
      setKyc(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchMyKyc(controller.signal);
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setKyc(result);
      }
    } catch (requestError) {
      if (
        mountedRef.current &&
        requestId === loadRequestIdRef.current &&
        !controller.signal.aborted
      ) {
        setError(getKycErrorMessage(requestError, t));
      }
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [isLoggedIn, t]);

  useEffect(() => {
    load();
  }, [load]);

  const status = getEffectiveStatus(kyc);
  const canSubmit = status === 'NONE' || status === 'REJECTED';
  const backRequired = idType !== 'PASSPORT';
  const selectedImages = useMemo(
    () => ({ front: frontImage, back: backImage, selfie: selfieImage }),
    [backImage, frontImage, selfieImage],
  );
  const idTypeOptions = useMemo(
    () => [
      { value: 'ID_CARD', label: t('kyc.idCard') },
      { value: 'PASSPORT', label: t('kyc.passport') },
      { value: 'DRIVER_LICENSE', label: t('kyc.driverLicense') },
    ],
    [t],
  );

  const setImage = useCallback((slot: ImageSlot, file: KycImageFile | null) => {
    if (slot === 'front') setFrontImage(file);
    if (slot === 'back') setBackImage(file);
    if (slot === 'selfie') setSelfieImage(file);
  }, []);

  const handlePickerResponse = useCallback(
    (slot: ImageSlot, response: ImagePickerResponse) => {
      if (!mountedRef.current) return;
      if (response.didCancel) return;
      if (response.errorCode) {
        const pickerMessage =
          response.errorCode === 'camera_unavailable'
            ? t('kyc.cameraUnavailable')
            : response.errorCode === 'permission'
            ? t('kyc.permissionDenied')
            : t('kyc.pickerFailed');
        setError(pickerMessage);
        return;
      }
      const asset = response.assets?.[0];
      try {
        setImage(slot, normalizePickedImage(asset, slot, t));
        setError('');
        setNotice('');
      } catch (pickerError) {
        setError(
          pickerError instanceof Error
            ? pickerError.message
            : t('kyc.pickerFailed'),
        );
      }
    },
    [setImage, t],
  );

  const openImageSource = useCallback(
    (slot: ImageSlot) => {
      if (submitting || pickerDialogOpenRef.current || pickerLockRef.current) {
        return;
      }
      pickerDialogOpenRef.current = true;
      const label = getSlotLabel(slot, t);
      Alert.alert(
        t('kyc.uploadTitle', { label }),
        t('kyc.chooseSource'),
        [
          {
            text: t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              pickerDialogOpenRef.current = false;
            },
          },
          {
            text: t('kyc.chooseLibrary'),
            onPress: async () => {
              pickerDialogOpenRef.current = false;
              if (pickerLockRef.current) return;
              pickerLockRef.current = true;
              try {
                const response = await launchImageLibrary({
                  ...IMAGE_OPTIONS,
                  restrictMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
                });
                handlePickerResponse(slot, response);
              } catch (pickerError) {
                if (mountedRef.current) {
                  setError(
                    pickerError instanceof Error
                      ? pickerError.message
                      : t('kyc.pickerFailed'),
                  );
                }
              } finally {
                pickerLockRef.current = false;
              }
            },
          },
          {
            text: t('kyc.takePhoto'),
            onPress: async () => {
              pickerDialogOpenRef.current = false;
              if (pickerLockRef.current) return;
              pickerLockRef.current = true;
              try {
                const response = await launchCamera({
                  ...IMAGE_OPTIONS,
                  cameraType: slot === 'selfie' ? 'front' : 'back',
                  saveToPhotos: false,
                });
                handlePickerResponse(slot, response);
              } catch (pickerError) {
                if (mountedRef.current) {
                  setError(
                    pickerError instanceof Error
                      ? pickerError.message
                      : t('kyc.pickerFailed'),
                  );
                }
              } finally {
                pickerLockRef.current = false;
              }
            },
          },
        ],
        {
          onDismiss: () => {
            pickerDialogOpenRef.current = false;
          },
        },
      );
    },
    [handlePickerResponse, submitting, t],
  );

  const submit = useCallback(async () => {
    if (
      submitLockRef.current ||
      submitting ||
      submitConfirmationOpenRef.current
    ) {
      return;
    }
    const validationError = validateKycForm(
      {
        fullName,
        countryCode,
        idNumber,
        idType,
        frontImage,
        backImage,
        selfieImage,
      },
      t,
    );
    if (validationError) {
      setError(validationError);
      return;
    }

    submitConfirmationOpenRef.current = true;
    Alert.alert(
      t('kyc.confirmTitle'),
      t('kyc.confirmDescription'),
      [
        {
          text: t('kyc.reviewAgain'),
          style: 'cancel',
          onPress: () => {
            submitConfirmationOpenRef.current = false;
          },
        },
        {
          text: t('kyc.confirmSubmit'),
          onPress: async () => {
            submitConfirmationOpenRef.current = false;
            if (
              submitLockRef.current ||
              !frontImage ||
              !selfieImage ||
              (idType !== 'PASSPORT' && !backImage)
            ) {
              return;
            }
            submitLockRef.current = true;
            setSubmitting(true);
            setError('');
            setNotice('');
            try {
              await submitMyKyc({
                kycLevel: 'PRIMARY',
                fullName: fullName.trim(),
                countryCode: countryCode.trim().toUpperCase(),
                idType,
                idNumber: idNumber.trim(),
                frontImage,
                backImage,
                selfieImage,
              });
              if (!mountedRef.current) return;
              setNotice(t('kyc.submittedNotice'));
              setFrontImage(null);
              setBackImage(null);
              setSelfieImage(null);
              await Promise.allSettled([load(), restoreSession()]);
            } catch (submitError) {
              if (mountedRef.current) {
                setError(getKycErrorMessage(submitError, t));
              }
            } finally {
              submitLockRef.current = false;
              if (mountedRef.current) setSubmitting(false);
            }
          },
        },
      ],
      {
        onDismiss: () => {
          submitConfirmationOpenRef.current = false;
        },
      },
    );
  }, [
    backImage,
    countryCode,
    frontImage,
    fullName,
    idNumber,
    idType,
    load,
    restoreSession,
    selfieImage,
    submitting,
    t,
  ]);

  return (
    <AppScreen>
      <ActionHeader
        backAccessibilityLabel={t('common.back')}
        title={t('kyc.title')}
        subtitle={t('kyc.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <RefreshButton
            accessibilityLabel={t('common.refresh')}
            disabled={loading || submitting}
            onPress={load}
          />
        }
      />

      {!isLoggedIn ? (
        <AuthRequiredCard
          actionTitle={t('auth.goLogin')}
          description={t('auth.requiredAccountDescription')}
          onLoginPress={() => navigation.navigate('Auth', { screen: 'Login' })}
          title={t('auth.requiredTitle')}
        />
      ) : loading && !kyc ? (
        <StateCard
          title={t('kyc.loading')}
          description={t('common.pleaseWait')}
        />
      ) : (
        <>
          <KycStatusCard kyc={kyc} status={status} t={t} />

          {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
          {notice ? <InlineNotice tone="green">{notice}</InlineNotice> : null}

          {canSubmit ? (
            <ActionCard>
              <View style={styles.formTitleRow}>
                <View style={styles.formTitleIcon}>
                  <ShieldCheck color={colors.gold} size={20} />
                </View>
                <View style={styles.formTitleText}>
                  <Text style={styles.formTitle}>
                    {status === 'REJECTED'
                      ? t('kyc.resubmitTitle')
                      : t('kyc.primaryTitle')}
                  </Text>
                  <Text style={styles.formSubtitle}>
                    {t('kyc.formDescription')}
                  </Text>
                </View>
              </View>

              <ActionTextField
                label={t('kyc.fullName')}
                value={fullName}
                onChangeText={setFullName}
                placeholder={t('kyc.fullNamePlaceholder')}
                maxLength={80}
                autoCorrect={false}
              />
              <ActionTextField
                label={t('kyc.countryCode')}
                value={countryCode}
                onChangeText={value =>
                  setCountryCode(value.replace(/[^a-z]/gi, '').toUpperCase())
                }
                placeholder={t('kyc.countryCodePlaceholder')}
                maxLength={2}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <SelectChips
                label={t('kyc.idType')}
                value={idType}
                options={idTypeOptions}
                onChange={value => {
                  setIdType(value as KycIdType);
                  if (value === 'PASSPORT') setBackImage(null);
                }}
              />
              <ActionTextField
                label={t('kyc.idNumber')}
                value={idNumber}
                onChangeText={setIdNumber}
                placeholder={t('kyc.idNumberPlaceholder')}
                maxLength={64}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              <View style={styles.uploadSection}>
                <SectionLabel>{t('kyc.photos')}</SectionLabel>
                <Text style={styles.uploadHint}>{t('kyc.photoHint')}</Text>
                <KycUploadCard
                  file={selectedImages.front}
                  label={t('kyc.frontImage')}
                  required
                  onPress={() => openImageSource('front')}
                  onRemove={() => setImage('front', null)}
                  t={t}
                />
                {backRequired ? (
                  <KycUploadCard
                    file={selectedImages.back}
                    label={t('kyc.backImage')}
                    required
                    onPress={() => openImageSource('back')}
                    onRemove={() => setImage('back', null)}
                    t={t}
                  />
                ) : null}
                <KycUploadCard
                  file={selectedImages.selfie}
                  label={t('kyc.selfieImage')}
                  required
                  onPress={() => openImageSource('selfie')}
                  onRemove={() => setImage('selfie', null)}
                  t={t}
                />
              </View>

              <View style={styles.privacyBox}>
                <FileCheck2 color={colors.green} size={18} />
                <Text style={styles.privacyText}>{t('kyc.privacy')}</Text>
              </View>
              <View style={styles.submitButton}>
                <PrimaryButton
                  title={submitting ? t('kyc.submitting') : t('kyc.submit')}
                  disabled={submitting}
                  onPress={submit}
                />
              </View>
            </ActionCard>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

function KycStatusCard({
  kyc,
  status,
  t,
}: {
  kyc: MyKyc | null;
  status: KycReviewStatus;
  t: Translator;
}) {
  const meta = getStatusMeta(status, t);
  const Icon = meta.Icon;
  const latest = kyc?.latestSubmission;
  return (
    <ActionCard style={styles.statusCard}>
      <View style={styles.statusHeader}>
        <View style={[styles.statusIcon, { backgroundColor: meta.softColor }]}>
          <Icon color={meta.color} size={22} />
        </View>
        <View style={styles.statusTitleWrap}>
          <Text style={styles.statusEyebrow}>{t('kyc.statusLabel')}</Text>
          <Text style={[styles.statusTitle, { color: meta.color }]}>
            {meta.title}
          </Text>
        </View>
        <View style={[styles.statusBadge, { borderColor: meta.color }]}>
          <Text style={[styles.statusBadgeText, { color: meta.color }]}>
            {meta.badge}
          </Text>
        </View>
      </View>
      <Text style={styles.statusDescription}>
        {status === 'REJECTED' && latest?.reviewNote
          ? latest.reviewNote
          : meta.description}
      </Text>
      {latest ? (
        <View style={styles.statusInfo}>
          <InfoRow
            label={t('kyc.level')}
            value={formatKycLevel(latest.kycLevel, t)}
          />
          <InfoRow label={t('kyc.fullName')} value={latest.fullName} />
          <InfoRow
            label={t('kyc.idType')}
            value={formatIdType(latest.idType, t)}
          />
          <InfoRow
            label={t('kyc.idNumber')}
            value={maskKycId(latest.idNumber)}
            mono
          />
          <InfoRow
            label={t('kyc.submittedAt')}
            value={formatKycDate(latest.createdAt)}
          />
        </View>
      ) : (
        <View style={styles.statusInfo}>
          <InfoRow
            label={t('kyc.currentLevel')}
            value={kyc?.kycLevel ? `KYC ${kyc.kycLevel}` : t('kyc.unverified')}
          />
        </View>
      )}
    </ActionCard>
  );
}

function KycUploadCard({
  file,
  label,
  required,
  onPress,
  onRemove,
  t,
}: {
  file: KycImageFile | null;
  label: string;
  required?: boolean;
  onPress: () => void;
  onRemove: () => void;
  t: Translator;
}) {
  return (
    <View style={[styles.uploadCard, file ? styles.uploadCardReady : null]}>
      <Pressable
        accessibilityLabel={t('kyc.uploadA11y', { label })}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.uploadMain,
          pressed ? styles.pressed : null,
        ]}
      >
        {file ? (
          <Image source={{ uri: file.uri }} style={styles.uploadPreview} />
        ) : (
          <View style={styles.uploadPlaceholder}>
            <ImagePlus color={colors.textMuted} size={25} />
          </View>
        )}
        <View style={styles.uploadTextWrap}>
          <Text style={styles.uploadLabel}>
            {label}
            {required ? <Text style={styles.required}> *</Text> : null}
          </Text>
          <Text numberOfLines={1} style={styles.uploadMeta}>
            {file
              ? `${file.name} · ${formatFileSize(file.fileSize, t)}`
              : t('kyc.chooseImage')}
          </Text>
        </View>
        <Camera color={file ? colors.green : colors.gold} size={20} />
      </Pressable>
      {file ? (
        <Pressable
          accessibilityLabel={t('kyc.removeA11y', { label })}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(240, 90, 90, 0.12)' }}
          hitSlop={6}
          onPress={onRemove}
          style={({ pressed }) => [
            styles.removeButton,
            pressed ? styles.pressed : null,
          ]}
        >
          <Text style={styles.removeText}>{t('kyc.remove')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function normalizePickedImage(
  asset: Asset | undefined,
  slot: ImageSlot,
  t?: Translator,
): KycImageFile {
  const uri = asset?.uri?.trim() || '';
  if (!uri) {
    throw new Error(
      t?.('kyc.imageMissing') || '未读取到图片文件，请重新选择。',
    );
  }
  const fileSize =
    typeof asset?.fileSize === 'number' && Number.isFinite(asset.fileSize)
      ? asset.fileSize
      : null;
  if (fileSize !== null && fileSize > MAX_IMAGE_BYTES) {
    throw new Error(t?.('kyc.imageTooLarge') || '单张图片不能超过 2 MB。');
  }

  const rawType = asset?.type?.trim().toLowerCase() || '';
  const fileName = asset?.fileName?.trim().toLowerCase() || '';
  const type = resolveImageMimeType(rawType, fileName);
  if (!type) {
    throw new Error(
      t?.('kyc.imageUnsupported') || '仅支持 JPG、PNG 或 WebP 图片。',
    );
  }
  const extension =
    type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return {
    uri,
    name: `kyc-${slot}-${Date.now()}.${extension}`,
    type,
    fileSize,
  };
}

function resolveImageMimeType(rawType: string, fileName: string) {
  if (rawType === 'image/jpeg' || rawType === 'image/jpg') return 'image/jpeg';
  if (rawType === 'image/png') return 'image/png';
  if (rawType === 'image/webp') return 'image/webp';
  if (/\.(jpe?g)$/.test(fileName)) return 'image/jpeg';
  if (/\.png$/.test(fileName)) return 'image/png';
  if (/\.webp$/.test(fileName)) return 'image/webp';
  return null;
}

export function validateKycForm(
  {
    fullName,
    countryCode,
    idNumber,
    idType,
    frontImage,
    backImage,
    selfieImage,
  }: {
    fullName: string;
    countryCode: string;
    idNumber: string;
    idType: KycIdType;
    frontImage: KycImageFile | null;
    backImage: KycImageFile | null;
    selfieImage: KycImageFile | null;
  },
  t?: Translator,
) {
  if (!fullName.trim()) {
    return t?.('kyc.validationFullName') || '请填写真实姓名。';
  }
  if (!/^[A-Za-z]{2}$/.test(countryCode.trim())) {
    return (
      t?.('kyc.validationCountryCode') ||
      '国家/地区代码应为两个英文字母，例如 CN。'
    );
  }
  if (!idNumber.trim()) {
    return t?.('kyc.validationIdNumber') || '请填写证件号码。';
  }
  if (!frontImage) {
    return t?.('kyc.validationFrontImage') || '请上传证件正面照片。';
  }
  if (idType !== 'PASSPORT' && !backImage) {
    return t?.('kyc.validationBackImage') || '请上传证件背面照片。';
  }
  if (!selfieImage) {
    return t?.('kyc.validationSelfieImage') || '请上传本人手持证件或自拍照片。';
  }
  return '';
}

export function getEffectiveStatus(kyc: MyKyc | null): KycReviewStatus {
  const latestStatus = kyc?.latestSubmission?.reviewStatus;
  if (latestStatus && latestStatus !== 'NONE') return latestStatus;
  if ((kyc?.kycLevel || 0) > 0) return 'APPROVED';
  return kyc?.kycStatus || 'NONE';
}

export function maskKycId(value: string) {
  const text = value.trim();
  if (text.length <= 4) return '*'.repeat(text.length);
  if (text.length <= 8) return `${text.slice(0, 2)}****${text.slice(-2)}`;
  return `${text.slice(0, 3)}${'*'.repeat(
    Math.min(10, text.length - 7),
  )}${text.slice(-4)}`;
}

function getSlotLabel(slot: ImageSlot, t?: Translator) {
  if (slot === 'front') return t?.('kyc.frontImage') || '证件正面';
  if (slot === 'back') return t?.('kyc.backImage') || '证件背面';
  return t?.('kyc.selfieImage') || '本人手持证件/自拍';
}

export function formatKycDate(value: string | null) {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(
    parsed.getDate(),
  )} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function formatFileSize(value: number | null, t?: Translator) {
  if (value === null) {
    return t?.('kyc.sizeSystemCheck') || '大小由系统校验';
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatIdType(value: KycIdType, t?: Translator) {
  if (value === 'ID_CARD') return t?.('kyc.idCard') || '身份证';
  if (value === 'PASSPORT') return t?.('kyc.passport') || '护照';
  return t?.('kyc.driverLicense') || '驾驶证';
}

function formatKycLevel(value: string, t?: Translator) {
  return value === 'ADVANCED'
    ? t?.('kyc.advancedLevel') || '高级认证'
    : t?.('kyc.primaryLevel') || '一级认证';
}

function getStatusMeta(status: KycReviewStatus, t?: Translator) {
  if (status === 'PENDING') {
    return {
      title: t?.('kyc.statusPendingTitle') || '材料审核中',
      badge: t?.('kyc.statusPendingBadge') || '待审核',
      description:
        t?.('kyc.statusPendingDescription') ||
        '后台正在审核你的身份材料，审核期间无需重复提交。',
      color: colors.warning,
      softColor: 'rgba(243,179,74,0.14)',
      Icon: Clock3,
    };
  }
  if (status === 'APPROVED') {
    return {
      title: t?.('kyc.statusApprovedTitle') || '身份认证已通过',
      badge: t?.('kyc.statusApprovedBadge') || '已认证',
      description:
        t?.('kyc.statusApprovedDescription') ||
        '账户已完成身份认证，可使用需要实名校验的服务。',
      color: colors.green,
      softColor: 'rgba(25,195,125,0.14)',
      Icon: CheckCircle2,
    };
  }
  if (status === 'REJECTED') {
    return {
      title: t?.('kyc.statusRejectedTitle') || '认证未通过',
      badge: t?.('kyc.statusRejectedBadge') || '可重提',
      description:
        t?.('kyc.statusRejectedDescription') ||
        '请根据审核意见修正材料后重新提交。',
      color: colors.red,
      softColor: 'rgba(240,90,90,0.14)',
      Icon: XCircle,
    };
  }
  return {
    title: t?.('kyc.statusNoneTitle') || '尚未完成身份认证',
    badge: t?.('kyc.statusNoneBadge') || '未认证',
    description:
      t?.('kyc.statusNoneDescription') ||
      '完成一级认证后，可使用需要实名校验的账户服务。',
    color: colors.gold,
    softColor: colors.goldSoft,
    Icon: ShieldCheck,
  };
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  statusCard: { padding: 14 },
  statusHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusTitleWrap: { flex: 1, minWidth: 0 },
  statusEyebrow: { color: colors.textMuted, fontSize: 11 },
  statusTitle: { ...typography.bold, marginTop: 3, fontSize: 17 },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusBadgeText: { ...typography.bold, fontSize: 11 },
  statusDescription: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  statusInfo: { marginTop: 12 },
  formTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  formTitleIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.goldSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formTitleText: { flex: 1, minWidth: 0 },
  formTitle: { ...typography.bold, color: colors.text, fontSize: 16 },
  formSubtitle: {
    marginTop: 4,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  uploadSection: { marginTop: 16 },
  uploadHint: {
    marginTop: -3,
    marginBottom: 7,
    color: colors.textSubtle,
    fontSize: 11,
    lineHeight: 17,
  },
  uploadCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    backgroundColor: colors.cardAlt,
    overflow: 'hidden',
  },
  uploadCardReady: { borderColor: 'rgba(25,195,125,0.42)' },
  uploadMain: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
  },
  uploadPreview: {
    width: 58,
    height: 50,
    borderRadius: 7,
    resizeMode: 'cover',
  },
  uploadPlaceholder: {
    width: 58,
    height: 50,
    borderRadius: 7,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadTextWrap: { flex: 1, minWidth: 0 },
  uploadLabel: { ...typography.bold, color: colors.text, fontSize: 13 },
  required: { color: colors.gold },
  uploadMeta: { marginTop: 5, color: colors.textMuted, fontSize: 11 },
  removeButton: {
    minHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: { ...typography.medium, color: colors.red, fontSize: 12 },
  privacyBox: {
    marginTop: 14,
    borderRadius: 9,
    backgroundColor: 'rgba(25,195,125,0.09)',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 11,
  },
  privacyText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  submitButton: { marginTop: 14 },
});
