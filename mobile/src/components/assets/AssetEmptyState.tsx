import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors, typography} from '../../theme';

type Props = {
  title: string;
  description?: string;
  actionLabel?: string;
  onActionPress?: () => void;
};

function AssetEmptyState({
  title,
  description,
  actionLabel,
  onActionPress,
}: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {actionLabel && onActionPress ? (
        <Pressable style={styles.action} onPress={onActionPress}>
          <Text style={styles.actionText}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default React.memo(AssetEmptyState);

const styles = StyleSheet.create({
  wrap: {
    minHeight: 116,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 16,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 14,
    textAlign: 'center',
  },
  description: {
    marginTop: 7,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  action: {
    height: 32,
    minWidth: 92,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.gold,
    marginTop: 12,
    paddingHorizontal: 14,
  },
  actionText: {
    ...typography.bold,
    color: colors.white,
    fontSize: 12,
  },
});
