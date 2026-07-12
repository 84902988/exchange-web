import {Platform, type TextStyle} from 'react-native';

export const fontFiles = {
  regular: 'HarmonyOS_Sans_SC_Regular.ttf',
  medium: 'HarmonyOS_Sans_SC_Medium.ttf',
  bold: 'HarmonyOS_Sans_SC_Bold.ttf',
} as const;

const preferredFamily = 'HarmonyOS Sans SC';
const bundledHarmonyAssetsAvailable = false;
const systemFallbackFamily = Platform.select<string | undefined>({
  android: 'sans-serif',
  ios: undefined,
  default: undefined,
});

export const fontConfig = {
  preferredFamily,
  bundledHarmonyAssetsAvailable,
  fallbackFamily: systemFallbackFamily,
} as const;

export const fontFamily = {
  regular: bundledHarmonyAssetsAvailable ? preferredFamily : systemFallbackFamily,
  medium: bundledHarmonyAssetsAvailable ? preferredFamily : systemFallbackFamily,
  bold: bundledHarmonyAssetsAvailable ? preferredFamily : systemFallbackFamily,
  identifier: Platform.select<string>({
    android: 'monospace',
    ios: 'Menlo',
    default: 'monospace',
  }),
} as const;

type FontFace = 'regular' | 'medium' | 'bold';

function fontFace(
  family: FontFace,
  weight: TextStyle['fontWeight'],
): TextStyle {
  const resolvedFamily = fontFamily[family];
  return {
    ...(resolvedFamily ? {fontFamily: resolvedFamily} : {}),
    fontWeight: weight,
  };
}

const numericFeatures = {
  fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
};

export const typography = {
  regular: fontFace('regular', '400'),
  medium: fontFace('medium', '500'),
  semibold: fontFace('bold', '600'),
  bold: fontFace('bold', '600'),
  heavy: fontFace('bold', '700'),
  screenTitle: {
    ...fontFace('bold', '600'),
    fontSize: 22,
    lineHeight: 28,
  },
  sectionTitle: {
    ...fontFace('bold', '600'),
    fontSize: 16,
    lineHeight: 22,
  },
  body: {
    ...fontFace('regular', '400'),
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    ...fontFace('regular', '400'),
    fontSize: 12,
    lineHeight: 17,
  },
  action: {
    ...fontFace('medium', '500'),
    fontSize: 13,
    lineHeight: 18,
  },
  button: {
    ...fontFace('bold', '600'),
    fontSize: 15,
    lineHeight: 20,
  },
  cardNumber: {
    ...fontFace('bold', '600'),
    ...numericFeatures,
    fontSize: 24,
    lineHeight: 30,
  },
  marketPrice: {
    ...fontFace('medium', '500'),
    ...numericFeatures,
    fontSize: 15,
    lineHeight: 20,
  },
  number: {
    ...fontFace('medium', '500'),
    ...numericFeatures,
  },
  identifier: {
    fontFamily: fontFamily.identifier,
    fontWeight: '400' as TextStyle['fontWeight'],
    ...numericFeatures,
  },
};
