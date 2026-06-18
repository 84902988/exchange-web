import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {BadgePercent, Gift, Sparkles, Trophy} from 'lucide-react-native';
import type {LucideIcon} from 'lucide-react-native';
import {colors} from '../../theme';

type PromoItem = {
  title: string;
  subtitle: string;
  tag: string;
  Icon: LucideIcon;
};

const promos: PromoItem[] = [
  {
    title: '全民冠军杯',
    subtitle: '参与交易活动，瓜分 250,000 USDT 奖池',
    tag: '限时活动',
    Icon: Trophy,
  },
  {
    title: '新人专属任务',
    subtitle: '完成注册与首笔交易，领取新人奖励',
    tag: '新人福利',
    Icon: Gift,
  },
  {
    title: 'VIP 权益升级',
    subtitle: '提升等级，解锁更低手续费与专属权益',
    tag: 'VIP',
    Icon: Sparkles,
  },
  {
    title: '邀请好友奖励',
    subtitle: '邀请好友交易，获得 RCB 奖励',
    tag: '邀请',
    Icon: BadgePercent,
  },
];

const activeIndex = 0;
const activePromo = promos[activeIndex];

export default function HomePromoCarousel() {
  const Icon = activePromo.Icon;

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityLabel={`${activePromo.title}, ${activePromo.subtitle}`}
        accessibilityRole="button"
        style={styles.banner}>
        <View style={styles.glow} />
        <View style={styles.iconWrap}>
          <Icon color={colors.primary} size={25} strokeWidth={2.2} />
        </View>
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text style={styles.tag}>{activePromo.tag}</Text>
            <Text style={styles.page}>
              {activeIndex + 1}/{promos.length}
            </Text>
          </View>
          <Text style={styles.title}>{activePromo.title}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {activePromo.subtitle}
          </Text>
        </View>
      </Pressable>
      <View style={styles.dotRow}>
        {promos.map((item, index) => (
          <View
            key={item.title}
            style={index === activeIndex ? styles.activeDot : styles.dot}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  banner: {
    minHeight: 98,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    overflow: 'hidden',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  glow: {
    position: 'absolute',
    right: -34,
    top: -46,
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(0, 214, 163, 0.12)',
  },
  iconWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 214, 163, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0, 214, 163, 0.24)',
  },
  copy: {
    flex: 1,
    gap: 5,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tag: {
    overflow: 'hidden',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    color: colors.primary,
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(0, 214, 163, 0.1)',
  },
  page: {
    color: colors.textSubtle,
    fontSize: 11,
    fontWeight: '700',
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  activeDot: {
    width: 16,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.tabActive,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textSubtle,
  },
});
