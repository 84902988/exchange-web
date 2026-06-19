import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Crown, Handshake, Landmark, UserPlus} from 'lucide-react-native';
import type {LucideIcon} from 'lucide-react-native';
import {colors, typography} from '../../theme';

type QuickEntry = {
  title: string;
  description: string;
  Icon: LucideIcon;
};

const entries: QuickEntry[] = [
  {title: '邀请好友', description: '好友奖励', Icon: UserPlus},
  {title: '代理', description: '团队权益', Icon: Handshake},
  {title: 'VIP', description: '等级权益', Icon: Crown},
  {title: '委员会', description: '治理入口', Icon: Landmark},
];

export default function QuickEntryRow() {
  return (
    <View style={styles.row}>
      {entries.map(item => {
        const Icon = item.Icon;

        return (
          <Pressable
            accessibilityLabel={`${item.title}, ${item.description}`}
            accessibilityRole="button"
            key={item.title}
            style={styles.item}>
            <View style={styles.icon}>
              <Icon color={colors.gold} size={20} strokeWidth={2.2} />
            </View>
            <Text style={styles.label} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={styles.desc} numberOfLines={1}>
              {item.description}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginTop: 16,
    flexDirection: 'row',
    gap: 9,
  },
  item: {
    flex: 1,
    alignItems: 'center',
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.16)',
  },
  label: {
    ...typography.bold,
    marginTop: 7,
    color: colors.text,
    fontSize: 11,
  },
  desc: {
    ...typography.medium,
    marginTop: 3,
    color: colors.textSubtle,
    fontSize: 10,
  },
});
