import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {colors} from '../../theme';

const tabs = ['社区', '直播', '公告', '要闻', '活动', '快讯', '学院'];
const feed = [
  {time: '10:30', title: '平台完成现货撮合系统例行维护'},
  {time: '09:10', title: 'VIP 等级权益与手续费说明更新'},
  {time: '昨天', title: 'IPO Prime 新项目预约即将开放'},
];

export default function InfoFeed() {
  return (
    <View>
      <View style={styles.tabs}>
        {tabs.map((item, index) => (
          <Pressable key={item} style={styles.tab}>
            <Text style={[styles.tabText, index === 2 ? styles.activeText : null]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.list}>
        {feed.map(item => (
          <View key={item.title} style={styles.feedRow}>
            <Text style={styles.time}>{item.time}</Text>
            <Text style={styles.title}>{item.title}</Text>
          </View>
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
    marginBottom: 8,
  },
  tab: {
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  activeText: {
    color: colors.primary,
  },
  list: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  feedRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  time: {
    width: 48,
    color: colors.textSubtle,
    fontSize: 12,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
});
