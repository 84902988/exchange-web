import React from "react";

export default function InfoCard({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0a0d] overflow-hidden">
      {title ? (
        <div className="px-6 py-4 text-white font-medium border-b border-white/10">
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}
