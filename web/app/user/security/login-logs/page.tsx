'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import UserSidebar from '@/components/user/UserSidebar';
import EmptyState from '@/components/ui/EmptyState';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { getUserLoginLogs, type UserLoginLog } from '@/lib/api';

const formatDateTime = (value?: string | null, localeCode = 'zh-CN') => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(localeCode, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export default function LoginLogsPage() {
  const { locale, t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [logs, setLogs] = useState<UserLoginLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const toggleSidebar = () => setIsSidebarCollapsed((value) => !value);

  useEffect(() => {
    let alive = true;

    const run = async () => {
      setLoading(true);
      setErrorMessage('');

      try {
        const data = await getUserLoginLogs(20);
        if (!alive) return;
        setLogs(data);
      } catch (error) {
        if (!alive) return;
        console.error('Failed to fetch login logs:', error);
        setErrorMessage(t('loginLogsLoadFailed', 'user'));
      } finally {
        if (alive) setLoading(false);
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, [t]);

  const statusLabel = (status: string) => (status === 'SUCCESS' ? t('success', 'user') : t('failed', 'user'));
  const localeCode = locale === 'zh-TW' ? 'zh-TW' : locale === 'ja' ? 'ja-JP' : locale === 'en' ? 'en-US' : 'zh-CN';

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white">{t('loginLogs', 'user')}</h1>
              <p className="mt-2 text-sm text-white/50">{t('loginLogsDesc', 'user')}</p>
            </div>
            <Link
              href="/user"
              className="rounded border border-white/10 px-4 py-2 text-sm text-white/70 transition-colors hover:border-amber-500/50 hover:text-amber-400"
            >
              {t('backToUserCenter', 'user')}
            </Link>
          </div>

          <div className="rounded-lg border border-white/10 bg-[#0a0a0d] p-6">
            {errorMessage ? (
              <div className="mb-4 rounded-md border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-300">
                {errorMessage}
              </div>
            ) : null}

            {loading ? (
              <div className="py-10 text-center text-sm text-white/60">{t('loading', 'common')}</div>
            ) : logs.length ? (
              <div className="max-h-[calc(100vh-280px)] overflow-auto pr-1">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-white/10 text-white/45">
                    <tr>
                      <th className="px-3 py-3 font-medium">{t('loginTime', 'user')}</th>
                      <th className="px-3 py-3 font-medium">IP</th>
                      <th className="px-3 py-3 font-medium">{t('deviceBrowser', 'user')}</th>
                      <th className="px-3 py-3 font-medium">{t('status', 'user')}</th>
                      <th className="px-3 py-3 font-medium">{t('failureReason', 'user')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {logs.map((item) => (
                      <tr key={item.id} className="text-white/70">
                        <td className="px-3 py-4">{formatDateTime(item.created_at, localeCode)}</td>
                        <td className="px-3 py-4">{item.ip_address || '-'}</td>
                        <td className="px-3 py-4">
                          <div className="text-white/80">{item.device_name || '-'}</div>
                          <div className="mt-1 max-w-[320px] truncate text-xs text-white/35" title={item.user_agent || undefined}>
                            {item.user_agent || '-'}
                          </div>
                        </td>
                        <td className="px-3 py-4">
                          <span
                            className={`rounded-full border px-3 py-1 text-xs ${
                              item.login_status === 'SUCCESS'
                                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                                : 'border-red-400/30 bg-red-400/10 text-red-300'
                            }`}
                          >
                            {statusLabel(item.login_status)}
                          </span>
                        </td>
                        <td className="px-3 py-4 text-white/50">{item.failure_reason || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-10">
                <EmptyState title={t('noLoginLogs', 'user')} description="" icon={null} size="small" />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
