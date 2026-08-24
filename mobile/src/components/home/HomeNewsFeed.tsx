import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MobileAnnouncementSummary } from '../../api/mobileContent';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

type Props = {
  announcements?: readonly MobileAnnouncementSummary[];
  onPressAnnouncement?: (announcement: MobileAnnouncementSummary) => void;
  unreadAnnouncementIds?: ReadonlySet<string>;
};

export default function HomeNewsFeed({
  announcements = [],
  onPressAnnouncement,
  unreadAnnouncementIds,
}: Props) {
  const { t } = useLanguage();
  if (announcements.length === 0) {
    return null;
  }

  return (
    <View style={styles.list}>
      {announcements.map((announcement, index) => {
        const isUnread = unreadAnnouncementIds?.has(announcement.id) === true;
        const content = (
          <>
            <View style={styles.feedCopy}>
              <View style={styles.titleRow}>
                {isUnread ? (
                  <View
                    accessibilityLabel={t('home.unread')}
                    style={styles.unreadDot}
                  />
                ) : null}
                <Text style={styles.title} numberOfLines={1}>
                  {announcement.title}
                </Text>
              </View>
              {announcement.summary ? (
                <Text style={styles.summary} numberOfLines={2}>
                  {announcement.summary}
                </Text>
              ) : null}
              <View style={styles.meta}>
                {announcement.categoryLabel ? (
                  <Text style={styles.category}>
                    {announcement.categoryLabel}
                  </Text>
                ) : null}
                {announcement.publishedAt ? (
                  <Text style={styles.date}>
                    {announcement.publishedAt.slice(0, 10)}
                  </Text>
                ) : null}
              </View>
            </View>
          </>
        );
        const rowStyle = [styles.feedRow, index > 0 ? styles.divider : null];

        return onPressAnnouncement ? (
          <Pressable
            accessibilityLabel={announcement.title}
            accessibilityRole="button"
            android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
            key={announcement.id}
            onPress={() => onPressAnnouncement(announcement)}
            style={({ pressed }) => [rowStyle, pressed ? styles.pressed : null]}
          >
            {content}
          </Pressable>
        ) : (
          <View key={announcement.id} style={rowStyle}>
            {content}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.995 }] },
  list: {
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.14)',
  },
  feedRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  feedCopy: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  unreadDot: {
    width: 7,
    height: 7,
    flexShrink: 0,
    borderRadius: 4,
    backgroundColor: colors.red,
  },
  title: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
  summary: {
    ...typography.regular,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  category: {
    ...typography.regular,
    color: colors.primary,
    fontSize: 11,
  },
  date: {
    ...typography.regular,
    color: colors.textSubtle,
    fontSize: 11,
  },
});
