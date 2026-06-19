import React, {type ReactNode} from 'react';
import {ScrollView, StyleSheet, View, type ViewStyle} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {colors, layout} from '../../theme';

type Props = {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: ViewStyle;
};

export default function AppScreen({children, scroll = true, contentStyle}: Props) {
  if (!scroll) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
        <View style={[styles.content, contentStyle, styles.contentBottomInset]}>
          {children}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
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
    paddingHorizontal: 16,
  },
  contentBottomInset: {
    paddingBottom: layout.tabBarContentInset,
  },
});
