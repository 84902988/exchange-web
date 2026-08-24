import React, {useEffect, useMemo, useState} from 'react';
import {Image, StyleSheet, Text, View, type ViewStyle} from 'react-native';
import type {MeOut} from '../../api/auth';
import {API_BASE_URL} from '../../config/env';
import {useLanguage} from '../../i18n';
import {colors, typography} from '../../theme';

type Props = {
  user?: MeOut | null;
  displayName?: string;
  size?: number;
  style?: ViewStyle;
};

export function resolveUserAvatarUrl(
  user?: MeOut | null,
  apiBaseUrl = API_BASE_URL,
) {
  const raw = (user?.avatar_url || user?.profile?.avatar_url || '').trim();
  if (!raw) return null;

  try {
    const parsed = raw.startsWith('/') ? new URL(raw, apiBaseUrl) : new URL(raw);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getUserAvatarLabel(value: string, emptyLabel = '账') {
  const text = value.trim();
  if (!text) return emptyLabel;
  const emailName = text.includes('@') ? text.split('@')[0] : text;
  return emailName.slice(0, 2).toUpperCase();
}

export default function UserAvatar({
  user,
  displayName = '',
  size = 44,
  style,
}: Props) {
  const {t} = useLanguage();
  const avatarUrl = useMemo(() => resolveUserAvatarUrl(user), [user]);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);
  const showImage = avatarUrl !== null && !imageFailed;

  const frameStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  return (
    <View
      accessibilityLabel={
        showImage ? undefined : t('appShell.userAvatarA11y')
      }
      accessible={!showImage}
      style={[styles.frame, frameStyle, style]}>
      {showImage ? (
        <Image
          accessibilityLabel={t('appShell.userAvatarA11y')}
          onError={() => setImageFailed(true)}
          source={{uri: avatarUrl}}
          style={[styles.image, frameStyle]}
        />
      ) : (
        <Text
          maxFontSizeMultiplier={1.1}
          style={[styles.fallbackText, {fontSize: Math.max(12, size * 0.34)}]}>
          {getUserAvatarLabel(displayName, t('appShell.accountInitial'))}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.gold,
  },
  image: {
    resizeMode: 'cover',
  },
  fallbackText: {
    ...typography.bold,
    color: colors.black,
  },
});
