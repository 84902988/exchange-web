import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  createSupportTicket,
  fetchSupportTickets,
  type SupportTicketCategory,
  type SupportTicketOption,
} from '../../api/support';
import { ApiClientError } from '../../api/client';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  InlineNotice,
  SelectChips,
  StateCard,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import type { RootStackParamList } from '../../navigation/types';
import { createTranslator, useLanguage, type Translator } from '../../i18n';
import { colors, typography } from '../../theme';

type Navigation = NativeStackNavigationProp<
  RootStackParamList,
  'SupportTicketCreate'
>;

const defaultTranslator = createTranslator('zh-CN');

export function validateSupportTicketDraft(
  subject: string,
  content: string,
  t: Translator = defaultTranslator,
) {
  const cleanSubject = subject.trim();
  const cleanContent = content.trim();
  if (!cleanSubject) return t('supportTicket.create.subjectRequired');
  if (cleanSubject.length > 255) {
    return t('supportTicket.create.subjectTooLong');
  }
  if (!cleanContent) return t('supportTicket.create.contentRequired');
  if (cleanContent.length > 5000) {
    return t('supportTicket.create.contentTooLong');
  }
  return '';
}

export default function SupportTicketCreateScreen() {
  const navigation = useNavigation<Navigation>();
  const { t } = useLanguage();
  const tRef = useRef(t);
  tRef.current = t;
  const [categories, setCategories] = useState<
    SupportTicketOption<SupportTicketCategory>[]
  >([]);
  const [category, setCategory] = useState<SupportTicketCategory | ''>('');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const draftError = useMemo(
    () => validateSupportTicketDraft(subject, content, t),
    [content, subject, t],
  );

  const loadCategories = useCallback(async () => {
    if (loadLockRef.current) return;
    loadLockRef.current = true;
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSupportTickets({
        pageSize: 1,
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      setCategories(result.categories);
      setCategory(current => current || result.categories[0]?.value || '');
    } catch (requestError) {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(
          localizeSupportTicketError(
            requestError,
            tRef.current,
            tRef.current('supportTicket.create.categoriesLoadFailed'),
          ),
        );
      }
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
        loadLockRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadCategories().catch(() => undefined);
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      loadLockRef.current = false;
    };
  }, [loadCategories]);

  const submit = useCallback(async () => {
    if (submitLockRef.current || submitting || !category || draftError) {
      return;
    }
    submitLockRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const ticket = await createSupportTicket({ category, subject, content });
      if (mountedRef.current) {
        navigation.replace('SupportTicketDetail', { ticketId: ticket.id });
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(
          localizeSupportTicketError(
            requestError,
            tRef.current,
            tRef.current('supportTicket.create.submitFailed'),
          ),
        );
      }
    } finally {
      submitLockRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [category, content, draftError, navigation, subject, submitting]);

  return (
    <AppScreen>
      <ActionHeader
        title={t('supportTicket.create.title')}
        subtitle={t('supportTicket.create.subtitle')}
        onBack={() => navigation.goBack()}
      />
      {error && categories.length === 0 ? (
        <StateCard
          title={t('supportTicket.create.categoriesUnavailable')}
          description={error}
          actionTitle={t('supportTicket.reload')}
          onActionPress={() => loadCategories()}
        />
      ) : (
        <>
          <ActionCard>
            <Text style={styles.sectionTitle}>
              {t('supportTicket.create.issueInfo')}
            </Text>
            <SelectChips
              label={t('supportTicket.create.category')}
              value={category}
              options={categories}
              onChange={value => setCategory(value as SupportTicketCategory)}
              emptyText={
                loading
                  ? t('supportTicket.create.loadingCategories')
                  : t('supportTicket.create.noCategories')
              }
            />
            <ActionTextField
              label={t('supportTicket.create.subject')}
              value={subject}
              onChangeText={setSubject}
              placeholder={t('supportTicket.create.subjectPlaceholder')}
              maxLength={255}
            />
            <Text style={styles.counter}>{subject.length}/255</Text>
            <ActionTextField
              label={t('supportTicket.create.description')}
              value={content}
              onChangeText={setContent}
              placeholder={t('supportTicket.create.descriptionPlaceholder')}
              multiline
              maxLength={5000}
            />
            <Text style={styles.counter}>{content.length}/5000</Text>
          </ActionCard>
          {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
          <InlineNotice>
            {t('supportTicket.create.sensitiveWarning')}
          </InlineNotice>
          <View style={styles.submitWrap}>
            <PrimaryButton
              title={
                submitting
                  ? t('supportTicket.create.submitting')
                  : t('supportTicket.create.submit')
              }
              disabled={
                loading || submitting || !category || Boolean(draftError)
              }
              onPress={submit}
            />
          </View>
        </>
      )}
    </AppScreen>
  );
}

function localizeSupportTicketError(
  error: unknown,
  t: Translator,
  fallback: string,
) {
  if (
    error instanceof ApiClientError &&
    error.code === 'INVALID_SUPPORT_RESPONSE'
  ) {
    return t('supportTicket.contractInvalid');
  }
  return toChineseError(error, fallback, t);
}

const styles = StyleSheet.create({
  sectionTitle: { ...typography.bold, color: colors.text, fontSize: 15 },
  counter: {
    marginTop: 5,
    color: colors.textSubtle,
    fontSize: 10,
    textAlign: 'right',
  },
  submitWrap: { marginTop: 16 },
});
