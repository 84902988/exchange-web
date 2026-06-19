import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Bell, ChevronRight, Headphones, ShieldCheck} from 'lucide-react-native';
import type {LucideIcon} from 'lucide-react-native';
import {colors} from '../../theme';

type ServiceItem = {
  title: string;
  description: string;
  Icon: LucideIcon;
};

const services: ServiceItem[] = [
  {
    title: '保障与服务',
    description: '平台保障基金持续守护用户资产安全',
    Icon: ShieldCheck,
  },
  {
    title: '帮助中心和客户服务',
    description: '7×24 小时解答您的问题',
    Icon: Headphones,
  },
  {
    title: '最新公告',
    description: '查看平台公告、活动通知与系统更新',
    Icon: Bell,
  },
];

const notices = ['平台系统维护通知', '新用户注册活动已开启', '合约交易风险提示'];

export default function HomeNoticeService() {
  return (
    <View style={styles.card}>
      {services.map((item, index) => {
        const Icon = item.Icon;

        return (
          <Pressable
            accessibilityLabel={`${item.title}, ${item.description}`}
            accessibilityRole="button"
            key={item.title}
            style={[styles.serviceRow, index > 0 ? styles.divider : null]}>
            <View style={styles.iconWrap}>
              <Icon color={colors.primary} size={19} strokeWidth={2.2} />
            </View>
            <View style={styles.serviceCopy}>
              <Text style={styles.serviceTitle}>{item.title}</Text>
              <Text style={styles.serviceDesc} numberOfLines={1}>
                {item.description}
              </Text>
            </View>
            <ChevronRight color={colors.textSubtle} size={17} strokeWidth={2.1} />
          </Pressable>
        );
      })}
      <View style={styles.noticeBox}>
        {notices.map((item, index) => (
          <Pressable
            accessibilityLabel={item}
            accessibilityRole="button"
            key={item}
            style={[styles.noticeRow, index > 0 ? styles.noticeDivider : null]}>
            <View style={styles.noticeDot} />
            <Text style={styles.noticeText} numberOfLines={1}>
              {item}
            </Text>
            <Text style={styles.noticeTime}>今日</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.14)',
  },
  serviceRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.07)',
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(214, 168, 50, 0.17)',
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.2)',
  },
  serviceCopy: {
    flex: 1,
    gap: 3,
  },
  serviceTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  serviceDesc: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  noticeBox: {
    marginHorizontal: 12,
    marginBottom: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(155, 116, 30, 0.24)',
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.13)',
  },
  noticeRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
  },
  noticeDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(214, 168, 50, 0.12)',
  },
  noticeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.gold,
  },
  noticeText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
  },
  noticeTime: {
    color: colors.textSubtle,
    fontSize: 11,
  },
});
