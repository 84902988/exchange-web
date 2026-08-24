import React, {useCallback} from 'react';
import {Pressable, StyleSheet} from 'react-native';
import type {BottomTabBarButtonProps} from '@react-navigation/bottom-tabs';
import {beginMainTabTransitionBudget} from '../../performance/mainTabTransitionBudget';

/**
 * Keep main-tab navigation on Pressable's discrete press event so React gives
 * the route update input priority. A short realtime-yield budget is opened
 * before dispatch, while the pressed style supplies immediate touch feedback.
 */
export default function ResponsiveTabBarButton({
  accessibilityLabel,
  accessibilityState,
  children,
  onLongPress,
  onPress,
  style,
  testID,
}: BottomTabBarButtonProps) {
  const handlePress = useCallback(
    (event: Parameters<NonNullable<typeof onPress>>[0]) => {
      if (accessibilityState?.selected !== true) {
        beginMainTabTransitionBudget();
      }
      onPress?.(event);
    },
    [accessibilityState?.selected, onPress],
  );

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      android_ripple={{color: 'rgba(214,168,50,0.10)'}}
      onLongPress={onLongPress}
      onPress={handlePress}
      style={state => [
        style,
        state.pressed ? styles.pressed : null,
      ]}
      testID={testID}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.72,
    transform: [{scale: 0.97}],
  },
});
