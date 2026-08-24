import React, {useMemo, type ReactNode, type Ref} from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {
  resolveResponsiveLayout,
  type ResponsiveContentWidth,
} from '../../constants/responsiveLayout';
import {colors, layout} from '../../theme';

type Props = {
  children: ReactNode;
  scroll?: boolean;
  scrollRef?: Ref<ScrollView>;
  contentStyle?: StyleProp<ViewStyle>;
  contentWidth?: ResponsiveContentWidth;
};

export default function AppScreen({
  children,
  scroll = true,
  scrollRef,
  contentStyle,
  contentWidth = 'standard',
}: Props) {
  const {fontScale, height, width} = useWindowDimensions();
  const responsiveStyle = useMemo<ViewStyle>(() => {
    const responsive = resolveResponsiveLayout(
      width,
      height,
      fontScale,
      contentWidth,
    );
    return {
      paddingHorizontal: responsive.horizontalPadding,
      ...(responsive.contentMaxWidth
        ? {maxWidth: responsive.contentMaxWidth}
        : {}),
    };
  }, [contentWidth, fontScale, height, width]);

  if (!scroll) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
        <View
          style={[
            styles.content,
            responsiveStyle,
            contentStyle,
            styles.contentBottomInset,
          ]}>
          {children}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
      <ScrollView
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          responsiveStyle,
          contentStyle,
          styles.contentBottomInset,
        ]}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    width: '100%',
    alignSelf: 'center',
  },
  contentBottomInset: {
    paddingBottom: layout.tabBarContentInset,
  },
});
