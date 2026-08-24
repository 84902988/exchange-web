import React, { useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  useNavigation,
  useFocusEffect,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Bell, Headphones, MessageCircle, Plus } from 'lucide-react-native';
import {
  fetchMobileAnnouncementReadState,
  fetchMobileAnnouncements,
  fetchMobileMessageUnreadCounts,
  markAllMobileAnnouncementsRead,
  MobileContentContractError,
  type MobileAnnouncementSummary,
} from '../../api/mobileContent';
import { fetchSupportTickets, type SupportTicket } from '../../api/support';
import { ApiClientError } from '../../api/client';
import AppScreen from '../../components/common/AppScreen';
import HomeNewsFeed from '../../components/home/HomeNewsFeed';
import {
  ActionHeader,
  InlineNotice,
  RefreshButton,
  SmallTextButton,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type { RootStackParamList } from '../../navigation/types';
import { createTranslator, useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type CenterTab = 'announcements' | 'support';
const defaultTranslator = createTranslator('zh-CN');
type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'HomeMessageCenter'
>;

export default function HomeMessageCenterScreen() {
  const navigation = useNavigation<Navigation>();
  const { locale, t } = useLanguage();
  const route = useRoute<RouteProp<RootStackParamList, 'HomeMessageCenter'>>();
  const [activeTab, setActiveTab] = useState<CenterTab>(
    route.params?.initialTab ?? 'announcements',
  );
  const [announcements, setAnnouncements] = useState<
    MobileAnnouncementSummary[]
  >([]);
  const [announcementTotal, setAnnouncementTotal] = useState(0);
  const [announcementPage, setAnnouncementPage] = useState(1);
  const [announcementPages, setAnnouncementPages] = useState(1);
  const [announcementUnreadCount, setAnnouncementUnreadCount] = useState(0);
  const [announcementReadIds, setAnnouncementReadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [announcementReadReady, setAnnouncementReadReady] = useState(false);
  const [announcementReadError, setAnnouncementReadError] = useState('');
  const [announcementLoadingMore, setAnnouncementLoadingMore] = useState(false);
  const [announcementLoadMoreError, setAnnouncementLoadMoreError] =
    useState('');
  const [markingAll, setMarkingAll] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [supportUnreadCount, setSupportUnreadCount] = useState(0);
  const [ticketPage, setTicketPage] = useState(1);
  const [ticketPages, setTicketPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generationRef = useRef(0);
  const unreadCountsGenerationRef = useRef(0);
  const markAllLockRef = useRef(false);
  const ticketLoadMoreLockRef = useRef(false);
  const announcementLoadMoreLockRef = useRef(false);
  const readControllerRef = useRef<AbortController | null>(null);
  const markAllControllerRef = useRef<AbortController | null>(null);
  const markAllGenerationRef = useRef(0);

  const load = useCallback(
    async (tab: CenterTab) => {
      readControllerRef.current?.abort();
      const controller = new AbortController();
      readControllerRef.current = controller;
      const generation = ++generationRef.current;
      const unreadCountsGeneration = ++unreadCountsGenerationRef.current;
      ticketLoadMoreLockRef.current = false;
      announcementLoadMoreLockRef.current = false;
      setLoadingMore(false);
      setAnnouncementLoadingMore(false);
      fetchMobileMessageUnreadCounts({ signal: controller.signal })
        .then(unreadCounts => {
          if (
            controller.signal.aborted ||
            generation !== generationRef.current ||
            unreadCountsGeneration !== unreadCountsGenerationRef.current
          ) {
            return;
          }
          setAnnouncementUnreadCount(unreadCounts.announcements);
          setSupportUnreadCount(unreadCounts.supportReplies);
        })
        .catch(() => undefined);
      setLoading(true);
      setError('');
      setLoadMoreError('');
      try {
        if (tab === 'announcements') {
          const result = await fetchMobileAnnouncements({
            locale,
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setAnnouncements(result.items);
          setAnnouncementTotal(result.total);
          setAnnouncementPage(result.page);
          setAnnouncementPages(result.pages);
          setAnnouncementLoadMoreError('');
          setAnnouncementReadError('');
          try {
            const readState = await fetchMobileAnnouncementReadState(
              result.items.map(item => item.id),
              { signal: controller.signal },
            );
            if (
              controller.signal.aborted ||
              generation !== generationRef.current
            ) {
              return;
            }
            setAnnouncementReadIds(new Set(readState.readIds));
            setAnnouncementUnreadCount(readState.unreadCount);
            setAnnouncementReadReady(true);
          } catch (readError) {
            if (
              controller.signal.aborted ||
              generation !== generationRef.current
            ) {
              return;
            }
            setAnnouncementReadIds(new Set());
            setAnnouncementUnreadCount(0);
            setAnnouncementReadReady(false);
            setAnnouncementReadError(
              localizeMessageCenterError(
                readError,
                t,
                t('messageCenter.readStateSyncFailed'),
              ),
            );
          }
        } else {
          const result = await fetchSupportTickets({
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            generation !== generationRef.current
          ) {
            return;
          }
          setTickets(result.items);
          setTicketTotal(result.total);
          setTicketPage(result.page);
          setTicketPages(result.pages);
          setSupportUnreadCount(result.unreadReplyCount);
        }
      } catch (requestError) {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setError(
          localizeMessageCenterError(
            requestError,
            t,
            tab === 'announcements'
              ? t('messageCenter.announcementsLoadFailed')
              : t('messageCenter.supportLoadFailed'),
          ),
        );
      } finally {
        if (
          !controller.signal.aborted &&
          generation === generationRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [locale, t],
  );

  const loadMoreTickets = useCallback(async () => {
    if (
      loading ||
      loadingMore ||
      ticketLoadMoreLockRef.current ||
      ticketPage >= ticketPages
    ) {
      return;
    }
    ticketLoadMoreLockRef.current = true;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    const generation = ++generationRef.current;
    setLoadingMore(true);
    setLoadMoreError('');
    try {
      const result = await fetchSupportTickets({
        page: ticketPage + 1,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      setTickets(current => {
        const known = new Set(current.map(ticket => ticket.id));
        return [
          ...current,
          ...result.items.filter(ticket => !known.has(ticket.id)),
        ];
      });
      setTicketTotal(result.total);
      setTicketPage(result.page);
      setTicketPages(result.pages);
      setSupportUnreadCount(result.unreadReplyCount);
    } catch (requestError) {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setLoadMoreError(
          localizeMessageCenterError(
            requestError,
            t,
            t('messageCenter.supportLoadMoreFailed'),
          ),
        );
      }
    } finally {
      if (readControllerRef.current === controller) {
        readControllerRef.current = null;
        ticketLoadMoreLockRef.current = false;
      }
      if (!controller.signal.aborted && generation === generationRef.current) {
        setLoadingMore(false);
      }
    }
  }, [loading, loadingMore, t, ticketPage, ticketPages]);

  const loadMoreAnnouncements = useCallback(async () => {
    if (
      loading ||
      announcementLoadingMore ||
      announcementLoadMoreLockRef.current ||
      announcementPage >= announcementPages
    ) {
      return;
    }
    announcementLoadMoreLockRef.current = true;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    const generation = ++generationRef.current;
    setAnnouncementLoadingMore(true);
    setAnnouncementLoadMoreError('');
    try {
      const result = await fetchMobileAnnouncements({
        page: announcementPage + 1,
        locale,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      const known = new Set(announcements.map(item => item.id));
      const merged = [
        ...announcements,
        ...result.items.filter(item => !known.has(item.id)),
      ];
      setAnnouncements(merged);
      setAnnouncementTotal(result.total);
      setAnnouncementPage(result.page);
      setAnnouncementPages(result.pages);
      try {
        const readState = await fetchMobileAnnouncementReadState(
          result.items.map(item => item.id),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setAnnouncementReadIds(current => {
          const mergedReadIds = new Set(current);
          readState.readIds.forEach(id => mergedReadIds.add(id));
          return mergedReadIds;
        });
        setAnnouncementUnreadCount(readState.unreadCount);
        setAnnouncementReadReady(true);
        setAnnouncementReadError('');
      } catch (readError) {
        if (controller.signal.aborted || generation !== generationRef.current) {
          return;
        }
        setAnnouncementReadReady(false);
        setAnnouncementReadError(
          localizeMessageCenterError(
            readError,
            t,
            t('messageCenter.readStateSyncFailed'),
          ),
        );
      }
    } catch (requestError) {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setAnnouncementLoadMoreError(
          localizeMessageCenterError(
            requestError,
            t,
            t('messageCenter.announcementLoadMoreFailed'),
          ),
        );
      }
    } finally {
      if (readControllerRef.current === controller) {
        readControllerRef.current = null;
        announcementLoadMoreLockRef.current = false;
      }
      if (!controller.signal.aborted && generation === generationRef.current) {
        setAnnouncementLoadingMore(false);
      }
    }
  }, [
    announcementLoadingMore,
    announcementPage,
    announcementPages,
    announcements,
    loading,
    locale,
    t,
  ]);

  const markAllAnnouncementsRead = useCallback(async () => {
    if (markAllLockRef.current || markingAll || !announcementReadReady) return;
    markAllLockRef.current = true;
    markAllControllerRef.current?.abort();
    const controller = new AbortController();
    markAllControllerRef.current = controller;
    const generation = ++markAllGenerationRef.current;
    unreadCountsGenerationRef.current += 1;
    setMarkingAll(true);
    setAnnouncementReadError('');
    try {
      const result = await markAllMobileAnnouncementsRead({
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        generation !== markAllGenerationRef.current
      ) {
        return;
      }
      setAnnouncementReadIds(new Set(announcements.map(item => item.id)));
      setAnnouncementUnreadCount(result.unreadCount);
      setAnnouncementReadReady(true);
    } catch (requestError) {
      if (
        controller.signal.aborted ||
        generation !== markAllGenerationRef.current
      ) {
        return;
      }
      setAnnouncementReadError(
        localizeMessageCenterError(
          requestError,
          t,
          t('messageCenter.markAllFailed'),
        ),
      );
    } finally {
      if (markAllControllerRef.current === controller) {
        markAllControllerRef.current = null;
        markAllLockRef.current = false;
      }
      if (
        !controller.signal.aborted &&
        generation === markAllGenerationRef.current
      ) {
        setMarkingAll(false);
      }
    }
  }, [announcementReadReady, announcements, markingAll, t]);

  useFocusEffect(
    useCallback(() => {
      markAllLockRef.current = false;
      setMarkingAll(false);
      load(activeTab).catch(() => undefined);
      return () => {
        readControllerRef.current?.abort();
        readControllerRef.current = null;
        markAllControllerRef.current?.abort();
        markAllControllerRef.current = null;
        ticketLoadMoreLockRef.current = false;
        announcementLoadMoreLockRef.current = false;
        markAllLockRef.current = false;
        generationRef.current += 1;
        unreadCountsGenerationRef.current += 1;
        markAllGenerationRef.current += 1;
      };
    }, [activeTab, load]),
  );

  const openAnnouncement = useCallback(
    (announcement: MobileAnnouncementSummary) => {
      navigation.navigate('MobileAnnouncementDetail', {
        announcementId: announcement.id,
        title: announcement.title,
      });
    },
    [navigation],
  );

  return (
    <AppScreen scroll={false} contentStyle={styles.screen}>
      <ActionHeader
        title={t('messageCenter.title')}
        subtitle={t('messageCenter.subtitle')}
        onBack={() => navigation.goBack()}
        right={
          <View style={styles.headerActions}>
            {activeTab === 'support' ? (
              <Pressable
                accessibilityLabel={t('messageCenter.createTicketA11y')}
                accessibilityRole="button"
                android_ripple={{
                  color: 'rgba(212, 175, 55, 0.12)',
                  borderless: true,
                }}
                onPress={() => navigation.navigate('SupportTicketCreate')}
                style={({ pressed }) => [
                  styles.createButton,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Plus color={colors.gold} size={18} strokeWidth={2.4} />
              </Pressable>
            ) : null}
            {activeTab === 'announcements' &&
            announcementReadReady &&
            announcementUnreadCount > 0 ? (
              <SmallTextButton
                title={
                  markingAll
                    ? t('messageCenter.processing')
                    : t('messageCenter.markAllRead')
                }
                disabled={markingAll}
                onPress={markAllAnnouncementsRead}
              />
            ) : null}
            <RefreshButton
              accessibilityLabel={t('common.refresh')}
              disabled={loading}
              onPress={() => load(activeTab)}
            />
          </View>
        }
      />
      <View accessibilityRole="tablist" style={styles.tabs}>
        <CenterTabButton
          active={activeTab === 'announcements'}
          Icon={Bell}
          label={t('messageCenter.announcementsTab')}
          count={announcementReadReady ? announcementUnreadCount : 0}
          onPress={() => {
            setActiveTab('announcements');
          }}
        />
        <CenterTabButton
          active={activeTab === 'support'}
          Icon={Headphones}
          label={t('messageCenter.supportTab')}
          count={supportUnreadCount}
          onPress={() => setActiveTab('support')}
        />
      </View>

      {error ? (
        <StateCard
          title={
            activeTab === 'announcements'
              ? t('messageCenter.announcementUnavailable')
              : t('messageCenter.supportUnavailable')
          }
          description={error}
          actionTitle={t('common.reload')}
          onActionPress={() => load(activeTab)}
        />
      ) : activeTab === 'announcements' ? (
        <AnnouncementPanel
          announcements={announcements}
          total={announcementTotal}
          loading={loading}
          loadingMore={announcementLoadingMore}
          loadMoreError={announcementLoadMoreError}
          hasMore={announcementPage < announcementPages}
          readIds={announcementReadIds}
          readReady={announcementReadReady}
          readError={announcementReadError}
          onLoadMore={loadMoreAnnouncements}
          onPress={openAnnouncement}
        />
      ) : (
        <SupportPanel
          loading={loading}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          total={ticketTotal}
          tickets={tickets}
          hasMore={ticketPage < ticketPages}
          onCreate={() => navigation.navigate('SupportTicketCreate')}
          onLoadMore={loadMoreTickets}
          onPressTicket={ticket =>
            navigation.navigate('SupportTicketDetail', { ticketId: ticket.id })
          }
        />
      )}
    </AppScreen>
  );
}

function CenterTabButton({
  active,
  Icon,
  label,
  count = 0,
  onPress,
}: {
  active: boolean;
  Icon: typeof Bell;
  label: string;
  count?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      android_ripple={{ color: 'rgba(212, 175, 55, 0.12)' }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tab,
        active ? styles.tabActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon color={active ? colors.gold : colors.textMuted} size={17} />
      <Text style={[styles.tabText, active ? styles.tabTextActive : null]}>
        {label}
      </Text>
      {count > 0 ? (
        <View style={styles.tabBadge}>
          <Text style={styles.tabBadgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function AnnouncementPanel({
  announcements,
  total,
  loading,
  loadingMore,
  loadMoreError,
  hasMore,
  readIds,
  readReady,
  readError,
  onLoadMore,
  onPress,
}: {
  announcements: MobileAnnouncementSummary[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: string;
  hasMore: boolean;
  readIds: ReadonlySet<string>;
  readReady: boolean;
  readError: string;
  onLoadMore: () => void;
  onPress: (announcement: MobileAnnouncementSummary) => void;
}) {
  const { t } = useLanguage();
  if (loading && announcements.length === 0) {
    return (
      <StateCard
        title={t('messageCenter.announcementLoading')}
        description={t('common.pleaseWait')}
      />
    );
  }
  if (announcements.length === 0) {
    return (
      <StateCard
        title={t('messageCenter.announcementEmpty')}
        description={t('messageCenter.announcementEmptyDescription')}
      />
    );
  }
  const unreadIds = readReady
    ? new Set(
        announcements
          .filter(item => !readIds.has(item.id))
          .map(item => item.id),
      )
    : undefined;
  return (
    <FlatList
      contentContainerStyle={styles.panelListContent}
      data={announcements}
      initialNumToRender={8}
      keyExtractor={item => item.id}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      maxToRenderPerBatch={8}
      removeClippedSubviews={Platform.OS === 'android'}
      renderItem={({ item }) => (
        <HomeNewsFeed
          announcements={[item]}
          unreadAnnouncementIds={unreadIds}
          onPressAnnouncement={onPress}
        />
      )}
      showsVerticalScrollIndicator={false}
      style={styles.panelList}
      updateCellsBatchingPeriod={40}
      windowSize={7}
      ItemSeparatorComponent={ListItemSeparator}
      ListHeaderComponent={
        <View style={styles.announcementSummaryRow}>
          <Text style={styles.listTitle}>
            {t('messageCenter.allAnnouncements')}
          </Text>
          <Text style={styles.count}>
            {t(
              total === 1
                ? 'messageCenter.itemCountOne'
                : 'messageCenter.itemCount',
              { count: total },
            )}
          </Text>
        </View>
      }
      ListFooterComponent={
        <>
          {hasMore ? (
            <View style={styles.loadMore}>
              <SmallTextButton
                title={
                  loadingMore
                    ? t('common.loading')
                    : t('messageCenter.loadMore')
                }
                disabled={loadingMore}
                onPress={onLoadMore}
              />
            </View>
          ) : null}
          {loadMoreError ? (
            <InlineNotice tone="red">{loadMoreError}</InlineNotice>
          ) : null}
          {readError ? <InlineNotice>{readError}</InlineNotice> : null}
        </>
      }
    />
  );
}

function SupportPanel({
  loading,
  loadingMore,
  loadMoreError,
  total,
  tickets,
  hasMore,
  onCreate,
  onLoadMore,
  onPressTicket,
}: {
  loading: boolean;
  loadingMore: boolean;
  loadMoreError: string;
  total: number;
  tickets: SupportTicket[];
  hasMore: boolean;
  onCreate: () => void;
  onLoadMore: () => void;
  onPressTicket: (ticket: SupportTicket) => void;
}) {
  const { t } = useLanguage();
  if (loading && tickets.length === 0) {
    return (
      <StateCard
        title={t('messageCenter.supportLoading')}
        description={t('common.pleaseWait')}
      />
    );
  }
  if (tickets.length === 0) {
    return (
      <StateCard
        title={t('messageCenter.supportEmpty')}
        description={t('messageCenter.supportEmptyDescription')}
        actionTitle={t('messageCenter.createTicket')}
        onActionPress={onCreate}
      />
    );
  }
  return (
    <FlatList
      contentContainerStyle={styles.panelListContent}
      data={tickets}
      initialNumToRender={8}
      keyExtractor={ticket => String(ticket.id)}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      maxToRenderPerBatch={8}
      removeClippedSubviews={Platform.OS === 'android'}
      renderItem={({ item: ticket }) => (
        <Pressable
          accessibilityLabel={t('messageCenter.supportTicketA11y', {
            subject: ticket.subject,
          })}
          accessibilityRole="button"
          android_ripple={{ color: 'rgba(216, 176, 74, 0.12)' }}
          onPress={() => onPressTicket(ticket)}
          style={({ pressed }) => [
            styles.ticketRow,
            pressed ? styles.ticketRowPressed : null,
          ]}
        >
          <View style={styles.messageIcon}>
            <MessageCircle color={colors.gold} size={17} />
          </View>
          <View style={styles.ticketCopy}>
            <View style={styles.ticketTitleRow}>
              {ticket.hasUnreadAdminReply ? (
                <View
                  accessibilityLabel={t('messageCenter.unreadSupportReply')}
                  style={styles.unreadDot}
                />
              ) : null}
              <Text style={styles.ticketSubject} numberOfLines={1}>
                {ticket.subject}
              </Text>
            </View>
            <Text style={styles.ticketMeta} numberOfLines={1}>
              {ticket.categoryLabel} ·{' '}
              {formatMessageCenterDate(ticket.updatedAt, t)}
            </Text>
          </View>
          <Text
            style={[
              styles.status,
              ticket.status === 'OPEN' ? styles.statusOpen : null,
              ticket.status === 'IN_PROGRESS' ? styles.statusInProgress : null,
              ticket.status === 'REPLIED' ? styles.statusReplied : null,
              ticket.status === 'CLOSED' ? styles.statusClosed : null,
            ]}
          >
            {ticket.statusLabel}
          </Text>
        </Pressable>
      )}
      showsVerticalScrollIndicator={false}
      style={styles.panelList}
      updateCellsBatchingPeriod={40}
      windowSize={7}
      ItemSeparatorComponent={ListItemSeparator}
      ListHeaderComponent={
        <View style={styles.listTitleRow}>
          <Text style={styles.listTitle}>{t('messageCenter.myRequests')}</Text>
          <Text style={styles.count}>
            {t(
              total === 1
                ? 'messageCenter.itemCountOne'
                : 'messageCenter.itemCount',
              { count: total },
            )}
          </Text>
        </View>
      }
      ListFooterComponent={
        <>
          {hasMore ? (
            <View style={styles.loadMore}>
              <SmallTextButton
                title={
                  loadingMore
                    ? t('common.loading')
                    : t('messageCenter.loadMore')
                }
                disabled={loadingMore}
                onPress={onLoadMore}
              />
            </View>
          ) : null}
          {loadMoreError ? (
            <InlineNotice tone="red">{loadMoreError}</InlineNotice>
          ) : null}
        </>
      }
    />
  );
}

function ListItemSeparator() {
  return <View style={styles.listSeparator} />;
}

export function formatMessageCenterDate(
  value: string | null,
  t: Translator = defaultTranslator,
) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return t('messageCenter.supportDate', {
    month: date.getMonth() + 1,
    day: date.getDate(),
    time: `${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes(),
    ).padStart(2, '0')}`,
  });
}

function localizeMessageCenterError(
  error: unknown,
  t: Translator,
  fallback: string,
) {
  if (error instanceof MobileContentContractError) {
    return t('messageCenter.contentContractInvalid');
  }
  if (
    error instanceof ApiClientError &&
    error.code === 'INVALID_SUPPORT_RESPONSE'
  ) {
    return t('messageCenter.supportContractInvalid');
  }
  return toChineseError(error, fallback, t);
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8, transform: [{ scale: 0.992 }] },
  screen: { flex: 1 },
  panelList: { flex: 1, marginTop: 2 },
  panelListContent: { paddingBottom: 16 },
  listSeparator: { height: 8 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  createButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  tabs: {
    height: 56,
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    padding: 4,
  },
  tab: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 9,
  },
  tabActive: { backgroundColor: colors.goldSoft },
  tabText: { ...typography.medium, color: colors.textMuted, fontSize: 12 },
  tabTextActive: { ...typography.bold, color: colors.gold },
  tabBadge: {
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.red,
  },
  tabBadgeText: { ...typography.bold, color: colors.white, fontSize: 9 },
  announcementSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  listTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  listTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  count: { color: colors.textMuted, fontSize: 11 },
  ticketRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
  },
  ticketRowPressed: { opacity: 0.84, transform: [{ scale: 0.99 }] },
  messageIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.goldSoft,
  },
  ticketCopy: { flex: 1 },
  ticketTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  unreadDot: {
    width: 7,
    height: 7,
    flexShrink: 0,
    borderRadius: 4,
    backgroundColor: colors.red,
  },
  ticketSubject: {
    ...typography.bold,
    flex: 1,
    color: colors.text,
    fontSize: 13,
  },
  ticketMeta: { marginTop: 4, color: colors.textSubtle, fontSize: 10 },
  status: { color: colors.textMuted, fontSize: 10 },
  statusOpen: { color: colors.gold },
  statusInProgress: { color: colors.blue },
  statusReplied: { color: colors.green },
  statusClosed: { color: colors.textMuted },
  loadMore: { alignItems: 'center', paddingTop: 8 },
});
