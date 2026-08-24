import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bell, ChevronRight } from 'lucide-react-native';
import type { MobileAnnouncementSummary } from '../../api/mobileContent';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

type Props = {
  announcements?: readonly MobileAnnouncementSummary[];
  onPressAnnouncement?: (announcement: MobileAnnouncementSummary) => void;
};

export default function HomeNoticeService({
  announcements = [],
  onPressAnnouncement,
}: Props) {
  if (announcements.length === 0) {
    return null;
  }

  return (
    <View style={styles.card}>
      {announcements.map((announcement, index) => (
        <AnnouncementRow
          announcement={announcement}
          isFirst={index === 0}
          key={announcement.id}
          onPress={onPressAnnouncement}
        />
      ))}
    </View>
  );
}

function AnnouncementRow({
  announcement,
  isFirst,
  onPress,
}: {
  announcement: MobileAnnouncementSummary;
  isFirst: boolean;
  onPress?: Props['onPressAnnouncement'];
}) {
  const { t } = useLanguage();
  const content = (
    <>
      <View style={styles.iconWrap}>
        <Bell color={colors.primary} size={18} strokeWidth={2.2} />
      </View>
      <View style={styles.copy}>
        <View style={styles.meta}>
          {announcement.isPinned ? (
            <Text style={styles.pinned}>{t('home.pinned')}</Text>
          ) : null}
          {announcement.categoryLabel ? (
            <Text style={styles.category}>{announcement.categoryLabel}</Text>
          ) : null}
          {announcement.publishedAt ? (
            <Text style={styles.date}>
              {announcement.publishedAt.slice(0, 10)}
            </Text>
          ) : null}
        </View>
        <Text style={styles.title} numberOfLines={1}>
          {announcement.title}
        </Text>
        {announcement.summary ? (
          <Text style={styles.summary} numberOfLines={2}>
            {announcement.summary}
          </Text>
        ) : null}
      </View>
      {onPress ? (
        <ChevronRight color={colors.textSubtle} size={17} strokeWidth={2.1} />
      ) : null}
    </>
  );
  const rowStyle = [styles.row, !isFirst ? styles.divider : null];

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={announcement.title}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
        onPress={() => onPress(announcement)}
        style={({ pressed }) => [rowStyle, pressed ? styles.pressed : null]}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={rowStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.995 }] },
  card: {
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.14)',
  },
  row: {
    minHeight: 70,
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
  copy: {
    flex: 1,
    gap: 3,
  },
  meta: {
    minHeight: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pinned: {
    ...typography.semibold,
    color: colors.primary,
    fontSize: 10,
  },
  category: {
    ...typography.caption,
    color: colors.textSubtle,
    fontSize: 10,
  },
  date: {
    ...typography.caption,
    marginLeft: 'auto',
    color: colors.textSubtle,
    fontSize: 10,
  },
  title: {
    ...typography.semibold,
    color: colors.text,
    fontSize: 14,
  },
  summary: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
});
