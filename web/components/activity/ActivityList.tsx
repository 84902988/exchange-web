"use client";

import ActivityCard from "@/components/activity/ActivityCard";
import { useLocaleContext } from "@/contexts/LocaleContext";
import type { Activity } from "@/lib/api/modules/activity";

export default function ActivityList({ activities }: { activities: Activity[] }) {
  const { t } = useLocaleContext();

  if (activities.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.04] px-6 py-14 text-center">
        <div className="text-lg font-semibold text-white">{t("noActivities", "activity")}</div>
        <p className="mt-2 text-sm text-white/55">{t("noActivitiesDesc", "activity")}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      {activities.slice(0, 6).map((activity) => (
        <ActivityCard key={activity.id} activity={activity} />
      ))}
    </div>
  );
}
