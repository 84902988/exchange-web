"use client";

import { useCallback, useEffect, useState } from "react";
import { getUserInfo, UserInfo } from "@/lib/api";

export function useProfile() {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getUserInfo(); // 调用 /me 接口
      setUserInfo(data);
    } catch (e: any) {
      console.error("getUserInfo failed:", e);
      setError(e?.message || "Failed to load profile");
      setUserInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    userInfo,
    loading,
    error,
    refresh,
    setUserInfo, // ✅ 用于头像/昵称/用户名修改后的本地即时更新
  };
}
