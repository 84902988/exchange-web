'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import UserSidebar from '@/components/user/UserSidebar';
import EmptyState from '@/components/ui/EmptyState';
import { useLocaleContext } from '@/contexts/LocaleContext';
import { getUserLoginLogs, type UserLoginLog } from '@/lib/api';

type DeviceRecord = {
  key: string;
  deviceName: string;
  ipAddress: string;
  lastLoginAt: string | null;
};

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

const toTime = (value?: string | null) => {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

const buildDeviceRecords = (logs: UserLoginLog[], unknownDevice: string): DeviceRecord[] => {
  const records = new Map<string, DeviceRecord>();
  const successLogs = logs
    .filter((item) => item.login_status === 'SUCCESS')
    .sort((a, b) => toTime(b.created_at) - toTime(a.created_at));

  successLogs.forEach((item) => {
    const deviceName = item.device_name || unknownDevice;
    const ipAddress = item.ip_address || '-';
    const key = `${deviceName}::${ipAddress}`;

    if (!records.has(key)) {
      records.set(key, {
        key,
        deviceName,
        ipAddress,
        lastLoginAt: item.created_at,
      });
    }
  });

  return Array.from(records.values());
};

export default function SecurityDevicesPage() {
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
        console.error('Failed to fetch device login logs:', error);
        setErrorMessage(t('deviceRecordsLoadFailed', 'user'));
      } finally {
        if (alive) setLoading(false);
      }
    };

    run();

    return () => {
      alive = false;
    };
  }, [t]);

  const localeCode = locale === 'zh-TW' ? 'zh-TW' : locale === 'ja' ? 'ja-JP' : locale === 'en' ? 'en-US' : 'zh-CN';
  const deviceRecords = useMemo(() => buildDeviceRecords(logs, t('unknownDevice', 'user')), [logs, t]);

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] py-8 lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 bg-[#0a0a0d] px-4 py-10">
        <div className="mx-auto max-w-5xl">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-white">{t('deviceManagement', 'user')}</h1>
              <p className="mt-2 text-sm text-white/50">{t('deviceManagementDesc', 'user')}</p>
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

            <div className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-white/50">
              {t('deviceNotice', 'user')}
            </div>

            {loading ? (
              <div className="py-10 text-center text-sm text-white/60">{t('loading', 'common')}</div>
            ) : deviceRecords.length ? (
              <div className="space-y-3">
                {deviceRecords.map((item, index) => {
                  const isCurrentDevice = index === 0;

                  return (
                    <div
                      key={item.key}
                      className="grid gap-4 rounded-lg border border-white/[0.06] bg-white/[0.03] p-4 text-sm md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-center"
                    >
                      <div>
                        <div className="font-medium text-white">{item.deviceName}</div>
                        <div className="mt-1 text-xs text-white/40">{t('deviceBrowser', 'user')}</div>
                      </div>
                      <div>
                        <div className="text-white/75">{item.ipAddress}</div>
                        <div className="mt-1 text-xs text-white/40">IP</div>
                      </div>
                      <div>
                        <div className="text-white/75">{formatDateTime(item.lastLoginAt, localeCode)}</div>
                        <div className="mt-1 text-xs text-white/40">{t('recentLoginTime', 'user')}</div>
                      </div>
                      <div>
                        <span
                          className={`inline-flex rounded-full border px-3 py-1 text-xs ${
                            isCurrentDevice
                              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                              : 'border-white/10 bg-white/[0.04] text-white/55'
                          }`}
                        >
                          {isCurrentDevice ? t('currentDevice', 'user') : t('recentLogin', 'user')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-10">
                <EmptyState
                  title={t('noDeviceRecords', 'user')}
                  description={t('noDeviceRecordsDesc', 'user')}
                  icon={null}
                  size="small"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
