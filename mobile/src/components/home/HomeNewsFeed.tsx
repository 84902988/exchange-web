import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Bell, BookOpen, Megaphone, MessageCircle, Newspaper, Radio, Video} from 'lucide-react-native';
import type {LucideIcon} from 'lucide-react-native';
import {colors, typography} from '../../theme';

type FeedTab = {
  title: string;
  Icon: LucideIcon;
};

const tabs: FeedTab[] = [
  {title: '社区', Icon: MessageCircle},
  {title: '直播', Icon: Video},
  {title: '公告', Icon: Bell},
  {title: '要闻', Icon: Newspaper},
  {title: '活动', Icon: Megaphone},
  {title: '快讯', Icon: Radio},
  {title: '学院', Icon: BookOpen},
];

const feed = [
  {time: '10:30', title: '平台完成现货撮合系统例行维护', tag: '公告'},
  {time: '09:10', title: 'VIP 等级权益与手续费说明更新', tag: '要闻'},
  {time: '昨天', title: 'IPO Prime 新项目预约即将开放', tag: '活动'},
];

export default function HomeNewsFeed() {
  return (
    <View>
      <View style={styles.tabs}>
        {tabs.map((item, index) => {
          const Icon = item.Icon;
          const active = index === 2;

          return (
            <Pressable
              accessibilityLabel={item.title}
              accessibilityRole="button"
              key={item.title}
              style={[styles.tab, active ? styles.activeTab : null]}>
              <Icon
                color={active ? colors.primary : colors.textSubtle}
                size={14}
                strokeWidth={2.1}
              />
              <Text style={[styles.tabText, active ? styles.activeText : null]}>
                {item.title}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.list}>
        {feed.map((item, index) => (
          <Pressable
            accessibilityLabel={`${item.tag}, ${item.title}`}
            accessibilityRole="button"
            key={item.title}
            style={[styles.feedRow, index > 0 ? styles.divider : null]}>
            <Text style={styles.time}>{item.time}</Text>
            <View style={styles.feedCopy}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.tag}>{item.tag}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
  },
  activeTab: {
    backgroundColor: colors.primarySoft,
    borderColor: 'rgba(214, 168, 50, 0.28)',
  },
  tabText: {
    ...typography.medium,
    color: colors.textMuted,
    fontSize: 12,
  },
  activeText: {
    color: colors.primary,
  },
  list: {
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.14)',
  },
  feedRow: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  time: {
    ...typography.regular,
    width: 42,
    color: colors.textSubtle,
    fontSize: 12,
  },
  feedCopy: {
    flex: 1,
    gap: 4,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 13,
  },
  tag: {
    ...typography.regular,
    color: colors.textSubtle,
    fontSize: 11,
  },
});
