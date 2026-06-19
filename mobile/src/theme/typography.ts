import type {TextStyle} from 'react-native';

export const fontFiles = {
  regular: 'HarmonyOS_Sans_SC_Regular.ttf',
  medium: 'HarmonyOS_Sans_SC_Medium.ttf',
  bold: 'HarmonyOS_Sans_SC_Bold.ttf',
} as const;

export const fontFamily = {
  regular: 'HarmonyOS Sans SC',
  medium: 'HarmonyOS Sans SC',
  bold: 'HarmonyOS Sans SC',
} as const;

function fontFace(
  family: keyof typeof fontFamily,
  weight: TextStyle['fontWeight'],
) {
  return {
    fontFamily: fontFamily[family],
    fontWeight: weight,
  };
}

export const typography = {
  regular: fontFace('regular', '400'),
  medium: fontFace('medium', '500'),
  bold: fontFace('bold', '700'),
  heavy: fontFace('bold', '900'),
  screenTitle: {
    ...fontFace('bold', '900'),
    fontSize: 28,
    lineHeight: 34,
  },
  sectionTitle: {
    ...fontFace('bold', '700'),
    fontSize: 17,
    lineHeight: 22,
  },
  body: {
    ...fontFace('regular', '400'),
    fontSize: 13,
    lineHeight: 20,
  },
  action: {
    ...fontFace('medium', '500'),
    fontSize: 12,
    lineHeight: 16,
  },
  number: {
    fontVariant: ['tabular-nums'] as const,
  },
};
