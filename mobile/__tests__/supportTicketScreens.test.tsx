import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { type ReactNode } from 'react';
import { Alert, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  supportTicketEn,
  supportTicketJa,
  supportTicketZhCN,
  supportTicketZhTW,
} from '../src/i18n/supportTicketCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
  useLanguage,
} from '../src/i18n';

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockFetchTickets = jest.fn();
const mockFetchDetail = jest.fn();
const mockCreateTicket = jest.fn();
const mockAddMessage = jest.fn();
const mockCloseTicket = jest.fn();
const mockMarkTicketRead = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: mockGoBack,
    navigate: mockNavigate,
    replace: mockReplace,
  }),
  useRoute: () => ({ params: { ticketId: 12 } }),
}));

jest.mock('../src/api/support', () => {
  const actual = jest.requireActual('../src/api/support');
  return {
    ...actual,
    fetchSupportTickets: (...args: unknown[]) => mockFetchTickets(...args),
    fetchSupportTicketDetail: (...args: unknown[]) => mockFetchDetail(...args),
    createSupportTicket: (...args: unknown[]) => mockCreateTicket(...args),
    addSupportTicketMessage: (...args: unknown[]) => mockAddMessage(...args),
    closeSupportTicket: (...args: unknown[]) => mockCloseTicket(...args),
    markSupportTicketRead: (...args: unknown[]) => mockMarkTicketRead(...args),
  };
});

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import SupportTicketCreateScreen, {
  validateSupportTicketDraft,
} from '../src/screens/home/SupportTicketCreateScreen';
import SupportTicketDetailScreen, {
  formatSupportTime,
} from '../src/screens/home/SupportTicketDetailScreen';

const ticket = {
  id: 12,
  ticketNo: 'TK202608020001',
  category: 'TRADING' as const,
  categoryLabel: '交易问题',
  subject: '订单咨询',
  content: '请协助核查',
  status: 'REPLIED' as const,
  statusLabel: '已回复',
  createdAt: '2026-08-02T09:00:00',
  updatedAt: '2026-08-02T09:10:00',
  hasUnreadAdminReply: true,
  messages: [
    {
      id: 20,
      senderType: 'USER' as const,
      message: '请协助核查',
      createdAt: '2026-08-02T09:00:00',
    },
    {
      id: 21,
      senderType: 'ADMIN' as const,
      message: '已为你核查完成',
      createdAt: '2026-08-02T09:10:00',
    },
  ],
};

function textContent(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string')
    .join(' ');
}

describe('support ticket mobile screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchTickets.mockResolvedValue({
      items: [ticket],
      total: 1,
      page: 1,
      pageSize: 50,
      pages: 1,
      categories: [
        { value: 'ACCOUNT', label: '账户问题' },
        { value: 'TRADING', label: '交易问题' },
      ],
      statuses: [{ value: 'REPLIED', label: '已回复' }],
      unreadReplyCount: 1,
    });
    mockFetchDetail.mockResolvedValue(ticket);
    mockMarkTicketRead.mockResolvedValue({
      lastReadMessageId: 21,
      unreadReplyCount: 0,
    });
    mockAddMessage.mockResolvedValue(ticket);
    mockCloseTicket.mockResolvedValue({ ...ticket, status: 'CLOSED' });
  });

  it('keeps every support ticket key explicit in all four languages', () => {
    const expectedKeys = Object.keys(supportTicketZhCN).sort();
    expect(expectedKeys).toHaveLength(50);
    expect(Object.keys(supportTicketZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(supportTicketEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(supportTicketJa).sort()).toEqual(expectedKeys);
    expect(
      validateSupportTicketDraft('', 'Problem', createTranslator('en')),
    ).toBe('Enter a ticket subject.');
    expect(createTranslator('ja')('supportTicket.detail.support')).toBe(
      'サポート',
    );
  });

  it('renders a backend-driven create form with sensitive-data warning', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<SupportTicketCreateScreen />);
      await Promise.resolve();
    });
    const text = textContent(renderer);
    expect(text).toContain('联系在线客服');
    expect(text).toContain('账户问题');
    expect(text).toContain('交易问题');
    expect(text).toContain('请勿提交登录密码');
    expect(
      renderer.root.findByProps({ accessibilityLabel: '提交工单' }).props
        .disabled,
    ).toBe(true);
    expect(mockCreateTicket).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders the real conversation and keeps writes idle during inspection', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<SupportTicketDetailScreen />);
      await Promise.resolve();
    });
    const text = textContent(renderer);
    expect(text).toContain('订单咨询');
    expect(text).toContain('已为你核查完成');
    expect(text).toContain('发送补充');
    expect(text).toContain('关闭工单');
    expect(mockFetchDetail).toHaveBeenCalledWith(12, {
      signal: expect.any(AbortSignal),
    });
    expect(mockMarkTicketRead).toHaveBeenCalledWith(12, 21, {
      signal: expect.any(AbortSignal),
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockCloseTicket).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders the English create form without submitting a ticket', async () => {
    const renderer = await renderEnglish(<SupportTicketCreateScreen />);
    const text = textContent(renderer);
    expect(text).toContain('Contact support');
    expect(text).toContain('Issue details');
    expect(text).toContain('Submit ticket');
    expect(text).toContain('never submit login passwords');
    expect(text).not.toContain('联系在线客服');
    expect(mockFetchTickets).toHaveBeenCalledTimes(1);
    expect(mockCreateTicket).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders the English detail without sending a reply or closing it', async () => {
    const renderer = await renderEnglish(<SupportTicketDetailScreen />);
    const text = textContent(renderer);
    expect(text).toContain('Support ticket');
    expect(text).toContain('Conversation');
    expect(text).toContain('Send update');
    expect(text).toContain('Close ticket');
    expect(text).toContain('Support');
    expect(mockMarkTicketRead).toHaveBeenCalledTimes(1);
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockCloseTicket).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('deduplicates the close confirmation and close request', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<SupportTicketDetailScreen />);
      await Promise.resolve();
    });

    const closeLabel = createTranslator('zh-CN')('supportTicket.detail.close');
    const closeButton = renderer.root
      .findAllByProps({ accessibilityLabel: closeLabel })
      .find(node => typeof node.props.onPress === 'function');
    act(() => {
      closeButton?.props.onPress();
      closeButton?.props.onPress();
    });
    expect(alert).toHaveBeenCalledTimes(1);

    const confirmLabel = createTranslator('zh-CN')(
      'supportTicket.detail.confirmClose',
    );
    const confirm = alert.mock.calls[0][2]?.find(
      button => button.text === confirmLabel,
    );
    await act(async () => {
      await Promise.all([confirm?.onPress?.(), confirm?.onPress?.()]);
    });
    expect(mockCloseTicket).toHaveBeenCalledTimes(1);
    expect(mockCloseTicket).toHaveBeenCalledWith(12);

    act(() => renderer.unmount());
    alert.mockRestore();
  });

  it('validates drafts and formats dates without locale-dependent output', () => {
    expect(validateSupportTicketDraft('', '问题')).toBe('请填写工单标题。');
    expect(validateSupportTicketDraft('标题', '')).toBe(
      '请描述需要客服协助的问题。',
    );
    expect(validateSupportTicketDraft('标题', '问题')).toBe('');
    expect(formatSupportTime('invalid')).toBe('--');
  });
});

function Ready({ children }: { children: ReactNode }) {
  const { ready } = useLanguage();
  return ready ? <>{children}</> : null;
}

async function renderEnglish(element: React.ReactElement) {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <LanguageProvider>
        <Ready>{element}</Ready>
      </LanguageProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}
