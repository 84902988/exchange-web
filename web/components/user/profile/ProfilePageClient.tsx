"use client";

import React from "react";
import UserSidebar from "@/components/user/UserSidebar";

import { useProfile } from "@/hooks/useProfile";
import DetailInfoCard from "./DetailInfoCard";
import { useLocaleContext } from "@/contexts/LocaleContext";

export default function ProfilePageClient() {
  const { t } = useLocaleContext();
  const { userInfo, loading, error, refresh, setUserInfo } = useProfile();

  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false);
  const toggleSidebar = () => setIsSidebarCollapsed((v) => !v);

  return (
    <main className="flex min-h-screen flex-col bg-[#0a0a0d] lg:flex-row">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="min-w-0 flex-1 px-4 py-10">
        <div className="w-full">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-white">
              {t("personalProfile", "user")}
            </h1>
            <p className="mt-2 text-sm text-white/50">{t("profilePageDesc", "user")}</p>
          </div>

          {loading ? (
            <div className="rounded-xl border border-white/10 bg-[#0a0a0d] p-6 text-white/70">
              {t("loading", "common")}
            </div>
          ) : error ? (
            <div className="rounded-xl border border-white/10 bg-[#0a0a0d] p-6">
              <div className="text-red-400 text-sm mb-3">{error}</div>
              <button
                onClick={refresh}
                className="px-4 py-2 rounded bg-white/10 hover:bg-white/15 text-white text-sm"
              >
                {t("retry", "common")}
              </button>
            </div>
          ) : userInfo ? (
            <DetailInfoCard
              userInfo={userInfo}
              onUserInfoChange={(next) => setUserInfo(next)}
              onRefresh={refresh}
            />
          ) : (
            <div className="rounded-xl border border-white/10 bg-[#0a0a0d] p-6 text-white/70">
              {t("profileNoUserInfo", "user")}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
