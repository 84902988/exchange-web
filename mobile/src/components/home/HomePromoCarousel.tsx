import React from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {
  MobileContentAction,
  MobilePromoContent,
} from '../../api/mobileContent';
import { colors, typography } from '../../theme';
import { useLanguage } from '../../i18n';

type Props = {
  promos?: readonly MobilePromoContent[];
  onAction?: (action: MobileContentAction, promo: MobilePromoContent) => void;
};

export default function HomePromoCarousel({ promos = [], onAction }: Props) {
  if (promos.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.track}
    >
      {promos.map(promo => (
        <PromoCard key={promo.id} promo={promo} onAction={onAction} />
      ))}
    </ScrollView>
  );
}

function PromoCard({
  promo,
  onAction,
}: {
  promo: MobilePromoContent;
  onAction?: Props['onAction'];
}) {
  const { t } = useLanguage();
  const content = (
    <>
      <Image
        accessibilityIgnoresInvertColors
        source={{ uri: promo.image.url }}
        style={styles.image}
        resizeMode="cover"
      />
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {promo.title}
        </Text>
        {promo.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {promo.subtitle}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (promo.action && onAction) {
    return (
      <Pressable
        accessibilityLabel={`${promo.title}${t('common.a11ySeparator')}${t(
          'common.viewDetails',
        )}`}
        accessibilityRole="button"
        android_ripple={{ color: 'rgba(212, 175, 55, 0.1)' }}
        onPress={() => onAction(promo.action!, promo)}
        style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={styles.card}>{content}</View>;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.84, transform: [{ scale: 0.992 }] },
  track: {
    gap: 10,
    paddingRight: 2,
  },
  card: {
    width: 286,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: '#151424',
    borderWidth: 1,
    borderColor: 'rgba(214, 168, 50, 0.16)',
  },
  image: {
    width: '100%',
    aspectRatio: 3,
    backgroundColor: colors.card,
  },
  copy: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.text,
    fontSize: 15,
  },
  subtitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
});
