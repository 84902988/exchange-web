import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, CheckCircle2 } from 'lucide-react-native';
import { launchImageLibrary, type Asset } from 'react-native-image-picker';
import {
  updateMyProfile,
  uploadMyAvatar,
  type AvatarImageFile,
} from '../../api';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  InlineNotice,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import UserAvatar from '../../components/common/UserAvatar';
import { useLanguage, type Translator } from '../../i18n';
import { useAuth } from '../../store/authStore';
import { colors, typography } from '../../theme';

const AVATAR_MAX_BYTES = 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function normalizeAvatarAsset(asset?: Asset, t?: Translator): AvatarImageFile {
  const uri = asset?.uri?.trim() || '';
  const rawType = asset?.type?.trim().toLowerCase() || '';
  const type = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  if (!uri || !ACCEPTED_TYPES.has(type)) {
    throw new Error(
      t?.('profile.imageTypeError') || '请选择 JPG、PNG 或 WebP 图片。',
    );
  }
  if (
    typeof asset?.fileSize === 'number' &&
    asset.fileSize > AVATAR_MAX_BYTES
  ) {
    throw new Error(
      t?.('profile.imageSizeError') ||
        '头像处理后仍超过 1 MB，请选择更小的图片。',
    );
  }
  return {
    uri,
    name: asset?.fileName?.trim() || `avatar_${Date.now()}.jpg`,
    type: type as AvatarImageFile['type'],
  };
}

export default function ProfileEditScreen({ navigation }: { navigation: any }) {
  const { t } = useLanguage();
  const { refreshUser, user } = useAuth();
  const originalUsername =
    user?.profile?.username?.trim() || user?.username?.trim() || '';
  const originalNickname =
    user?.profile?.nickname?.trim() || user?.nickname?.trim() || '';
  const [username, setUsername] = useState(originalUsername);
  const [nickname, setNickname] = useState(originalNickname);
  const [avatar, setAvatar] = useState<AvatarImageFile | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  const pickerLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const displayName =
    nickname ||
    username ||
    user?.email ||
    user?.phone ||
    t('profile.defaultName');
  const changed =
    username.trim() !== originalUsername ||
    nickname.trim() !== originalNickname ||
    avatar !== null;

  const validationError = useMemo(() => {
    const nextUsername = username.trim();
    const nextNickname = nickname.trim();
    if (username !== originalUsername && !nextUsername)
      return t('profile.usernameEmpty');
    if (nextUsername.length > 64) return t('profile.usernameTooLong');
    if (nickname !== originalNickname && !nextNickname)
      return t('profile.nicknameEmpty');
    if (nextNickname.length > 64) return t('profile.nicknameTooLong');
    return '';
  }, [nickname, originalNickname, originalUsername, t, username]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pickerLockRef.current = false;
    };
  }, []);

  const chooseAvatar = useCallback(async () => {
    if (saving || pickerLockRef.current) return;
    pickerLockRef.current = true;
    try {
      const response = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
        maxWidth: 1024,
        maxHeight: 1024,
        quality: 0.8,
        includeBase64: false,
        restrictMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
      if (!mountedRef.current || response.didCancel) return;
      if (response.errorCode) {
        setError(
          response.errorCode === 'permission'
            ? t('profile.permissionDenied')
            : t('profile.pickerFailed'),
        );
        return;
      }
      setAvatar(normalizeAvatarAsset(response.assets?.[0], t));
      setError('');
      setNotice('');
    } catch (pickerError) {
      if (mountedRef.current) {
        setError(toChineseError(pickerError, t('profile.imageUnavailable')));
      }
    } finally {
      pickerLockRef.current = false;
    }
  }, [saving, t]);

  const save = useCallback(async () => {
    if (submitLockRef.current || saving || !changed || validationError) return;
    submitLockRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    let profileSaved = false;
    try {
      if (
        username.trim() !== originalUsername ||
        nickname.trim() !== originalNickname
      ) {
        await updateMyProfile({
          ...(username.trim() !== originalUsername
            ? { username: username.trim() }
            : {}),
          ...(nickname.trim() !== originalNickname
            ? { nickname: nickname.trim() }
            : {}),
        });
        profileSaved = true;
      }
      if (avatar) await uploadMyAvatar(avatar);
      await refreshUser();
      if (mountedRef.current) {
        setAvatar(null);
        setNotice(t('profile.saved'));
      }
    } catch (requestError) {
      if (profileSaved) {
        await refreshUser().catch(() => undefined);
        if (mountedRef.current) setError(t('profile.avatarUploadFailed'));
      } else if (mountedRef.current) {
        setError(toChineseError(requestError, t('profile.saveFailed')));
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [
    avatar,
    changed,
    nickname,
    originalNickname,
    originalUsername,
    refreshUser,
    saving,
    t,
    username,
    validationError,
  ]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('profile.title')}
        subtitle={t('profile.subtitle')}
        backAccessibilityLabel={t('common.back')}
        onBack={() => navigation.goBack()}
      />
      <ActionCard>
        <View style={styles.avatarSection}>
          <View style={styles.avatarFrame}>
            {avatar ? (
              <Image source={{ uri: avatar.uri }} style={styles.avatarImage} />
            ) : (
              <UserAvatar displayName={displayName} size={76} user={user} />
            )}
            <View style={styles.cameraBadge}>
              <Camera color={colors.black} size={14} strokeWidth={2.4} />
            </View>
          </View>
          <View style={styles.avatarText}>
            <Text style={styles.avatarTitle}>{t('profile.avatarTitle')}</Text>
            <Text style={styles.avatarHint}>
              {t('profile.avatarDescription')}
            </Text>
            <Pressable
              accessibilityLabel={t('profile.chooseAvatar')}
              accessibilityRole="button"
              android_ripple={{ color: 'rgba(212, 175, 55, 0.14)' }}
              onPress={chooseAvatar}
              style={({ pressed }) => [
                styles.chooseButton,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={styles.chooseText}>{t('profile.chooseAvatar')}</Text>
            </Pressable>
          </View>
        </View>
        <ActionTextField
          label={t('profile.nickname')}
          value={nickname}
          onChangeText={setNickname}
          placeholder={t('profile.nicknamePlaceholder')}
          maxLength={64}
          autoCorrect={false}
        />
        <ActionTextField
          label={t('profile.username')}
          value={username}
          onChangeText={setUsername}
          placeholder={t('profile.usernamePlaceholder')}
          maxLength={64}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.accountRow}>
          <CheckCircle2 color={colors.green} size={17} />
          <Text style={styles.accountText}>{t('profile.emailNotice')}</Text>
        </View>
      </ActionCard>
      {validationError ? (
        <InlineNotice tone="red">{validationError}</InlineNotice>
      ) : null}
      {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="green">{notice}</InlineNotice> : null}
      <View style={styles.submitWrap}>
        <PrimaryButton
          title={saving ? t('profile.saving') : t('profile.save')}
          disabled={saving || !changed || Boolean(validationError)}
          onPress={save}
        />
      </View>
    </AppScreen>
  );
}

export { normalizeAvatarAsset };

const styles = StyleSheet.create({
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  avatarSection: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarFrame: { width: 76, height: 76 },
  avatarImage: { width: 76, height: 76, borderRadius: 38, resizeMode: 'cover' },
  cameraBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.card,
    backgroundColor: colors.gold,
  },
  avatarText: { flex: 1, minWidth: 0 },
  avatarTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  avatarHint: {
    marginTop: 5,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  chooseButton: {
    alignSelf: 'flex-start',
    marginTop: 4,
    minHeight: 44,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  chooseText: { ...typography.bold, color: colors.gold, fontSize: 12 },
  accountRow: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  accountText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
  },
  submitWrap: { marginTop: 16 },
});
