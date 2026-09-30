import React, {useCallback, useMemo, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {SvgCssUri} from 'react-native-svg/css';
import {API_BASE_URL} from '../../config/env';
import {colors, typography} from '../../theme';

type Props = {
  label: string;
  logoUrl?: string | null;
  positive?: boolean;
  size?: number;
};

export function resolveMarketLogoUrl(
  rawValue?: string | null,
  apiBaseUrl = API_BASE_URL,
) {
  const raw = String(rawValue || '').trim();
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

export default function MarketLogo({
  label,
  logoUrl,
  positive = true,
  size = 30,
}: Props) {
  const resolvedUrl = useMemo(() => resolveMarketLogoUrl(logoUrl), [logoUrl]);
  return <MarketLogoContent key={resolvedUrl ?? 'fallback'} label={label} resolvedUrl={resolvedUrl} positive={positive} size={size} />;
}

function MarketLogoContent({label, resolvedUrl, positive, size}: {
  label: string;
  resolvedUrl: string | null;
  positive: boolean;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  const onError = useCallback(() => setFailed(true), []);

  const frameStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };
  const showLogo = resolvedUrl !== null && !failed;
  const logoSize = Math.max(1, size - 4);
  const isSvg = showLogo
    ? new URL(resolvedUrl).pathname.toLowerCase().endsWith('.svg')
    : false;

  return (
    <View
      accessible={!showLogo}
      accessibilityLabel={!showLogo ? label : undefined}
      style={[
        styles.frame,
        positive ? styles.frameUp : styles.frameDown,
        showLogo && styles.logoFrame,
        frameStyle,
      ]}>
      {showLogo ? (
        <View
          style={[
            styles.logoMask,
            {
              width: logoSize,
              height: logoSize,
              borderRadius: logoSize / 2,
            },
          ]}>
          {isSvg ? (
            <SvgCssUri
              accessibilityLabel={label}
              height={logoSize}
              onError={onError}
              preserveAspectRatio="xMidYMid meet"
              uri={resolvedUrl}
              width={logoSize}
            />
          ) : (
            <Image
              accessibilityLabel={label}
              onError={onError}
              source={{uri: resolvedUrl}}
              style={[styles.image, {width: logoSize, height: logoSize}]}
            />
          )}
        </View>
      ) : (
        <Text
          maxFontSizeMultiplier={1.1}
          style={[styles.fallbackText, {fontSize: Math.max(9, size * 0.34)}]}>
          {label.trim().slice(0, 2).toUpperCase() || '--'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.marketLine,
  },
  frameUp: {
    backgroundColor: 'rgba(25, 195, 125, 0.14)',
  },
  frameDown: {
    backgroundColor: 'rgba(240, 90, 90, 0.14)',
  },
  logoFrame: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  logoMask: {
    // Clip both raster and SVG backgrounds without zooming the artwork.
    overflow: 'hidden',
    backgroundColor: colors.marketCardAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    resizeMode: 'contain',
  },
  fallbackText: {
    ...typography.semibold,
    color: colors.marketText,
  },
});
