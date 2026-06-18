"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import UserSidebar from "@/components/user/UserSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  addSupportTicketMessage,
  closeSupportTicket,
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  type SupportTicket,
  type SupportTicketOption,
} from "@/lib/api/modules/supportTickets";

const FALLBACK_CATEGORIES: SupportTicketOption[] = [
  { value: "ACCOUNT", label: "" },
  { value: "KYC", label: "" },
  { value: "DEPOSIT_WITHDRAW", label: "" },
  { value: "TRADING", label: "" },
  { value: "SECURITY", label: "" },
  { value: "OTHER", label: "" },
];

const FALLBACK_STATUSES: SupportTicketOption[] = [
  { value: "OPEN", label: "", badge: "warning" },
  { value: "IN_PROGRESS", label: "", badge: "info" },
  { value: "REPLIED", label: "", badge: "success" },
  { value: "CLOSED", label: "", badge: "muted" },
];

function toDateLocale(locale: string) {
  if (locale === "ja") return "ja-JP";
  if (locale === "en") return "en-US";
  if (locale === "zh-TW") return "zh-TW";
  return "zh-CN";
}

function formatDate(value: string | null | undefined, locale: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(toDateLocale(locale), { hour12: false });
}

function statusClass(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "REPLIED") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (normalized === "IN_PROGRESS") return "border-sky-400/30 bg-sky-500/10 text-sky-200";
  if (normalized === "CLOSED") return "border-white/15 bg-white/5 text-white/50";
  return "border-amber-400/30 bg-amber-500/10 text-amber-200";
}

function categoryLabel(category: string, fallback: string, t: (key: string, namespace?: "user") => string) {
  const normalized = String(category || "").toUpperCase();
  if (normalized === "ACCOUNT") return t("supportTicketCategoryAccount", "user");
  if (normalized === "KYC") return t("supportTicketCategoryKyc", "user");
  if (normalized === "DEPOSIT_WITHDRAW") return t("supportTicketCategoryDepositWithdraw", "user");
  if (normalized === "TRADING") return t("supportTicketCategoryTrading", "user");
  if (normalized === "SECURITY") return t("supportTicketCategorySecurity", "user");
  if (normalized === "OTHER") return t("supportTicketCategoryOther", "user");
  return fallback || category || "-";
}

function statusLabel(status: string, fallback: string, t: (key: string, namespace?: "user") => string) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "OPEN") return t("supportTicketStatusOpen", "user");
  if (normalized === "IN_PROGRESS") return t("supportTicketStatusInProgress", "user");
  if (normalized === "REPLIED") return t("supportTicketStatusReplied", "user");
  if (normalized === "CLOSED") return t("supportTicketStatusClosed", "user");
  return fallback || status || "-";
}

function messageSenderLabel(senderType: string, t: (key: string, namespace?: "user") => string) {
  return senderType.toUpperCase() === "ADMIN"
    ? t("supportTicketCustomerReply", "user")
    : t("supportTicketMySupplement", "user");
}

export default function SupportTicketsPage() {
  const { locale, t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null);
  const [categories, setCategories] = useState<SupportTicketOption[]>(FALLBACK_CATEGORIES);
  const [statuses, setStatuses] = useState<SupportTicketOption[]>(FALLBACK_STATUSES);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [replying, setReplying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [createForm, setCreateForm] = useState({
    category: "ACCOUNT",
    subject: "",
    content: "",
  });
  const [replyMessage, setReplyMessage] = useState("");

  const pageTitle = t("supportTickets", "user");
  const isSelectedClosed = String(selectedTicket?.status || "").toUpperCase() === "CLOSED";

  const statusOptions = useMemo(() => {
    return [
      { value: "", label: t("supportTicketAllStatuses", "user") },
      ...statuses.map((status) => ({
        ...status,
        label: statusLabel(status.value, status.label, t),
      })),
    ];
  }, [statuses, t]);

  const loadTickets = useCallback(
    async (nextSelectedId?: number | null) => {
      setLoading(true);
      setError("");
      try {
        const data = await listSupportTickets(statusFilter);
        setTickets(data.items || []);
        setCategories(data.categories?.length ? data.categories : FALLBACK_CATEGORIES);
        setStatuses(data.statuses?.length ? data.statuses : FALLBACK_STATUSES);
        const targetId = nextSelectedId ?? selectedTicket?.id ?? data.items?.[0]?.id ?? null;
        if (targetId) {
          try {
            const detail = await getSupportTicket(targetId);
            setSelectedTicket(detail);
          } catch {
            setSelectedTicket(null);
            setError(t("supportTicketDetailLoadFailed", "user"));
          }
        } else {
          setSelectedTicket(null);
        }
      } catch {
        setTickets([]);
        setSelectedTicket(null);
        setError(t("supportTicketLoadFailed", "user"));
      } finally {
        setLoading(false);
      }
    },
    [selectedTicket?.id, statusFilter, t],
  );

  useEffect(() => {
    let alive = true;
    async function run() {
      setLoading(true);
      setError("");
      try {
        const data = await listSupportTickets(statusFilter);
        if (!alive) return;
        setTickets(data.items || []);
        setCategories(data.categories?.length ? data.categories : FALLBACK_CATEGORIES);
        setStatuses(data.statuses?.length ? data.statuses : FALLBACK_STATUSES);
        const firstId = data.items?.[0]?.id;
        if (firstId) {
          try {
            const detail = await getSupportTicket(firstId);
            if (alive) setSelectedTicket(detail);
          } catch {
            if (!alive) return;
            setSelectedTicket(null);
            setError(t("supportTicketDetailLoadFailed", "user"));
          }
        } else {
          setSelectedTicket(null);
        }
      } catch {
        if (!alive) return;
        setTickets([]);
        setSelectedTicket(null);
        setError(t("supportTicketLoadFailed", "user"));
      } finally {
        if (alive) setLoading(false);
      }
    }
    run();
    return () => {
      alive = false;
    };
  }, [statusFilter, t]);

  const selectTicket = async (ticketId: number) => {
    setDetailLoading(true);
    setError("");
    try {
      setSelectedTicket(await getSupportTicket(ticketId));
    } catch {
      setSelectedTicket(null);
      setError(t("supportTicketDetailLoadFailed", "user"));
    } finally {
      setDetailLoading(false);
    }
  };

  const submitTicket = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    setNotice("");
    try {
      const created = await createSupportTicket(createForm);
      setCreateForm({ category: "ACCOUNT", subject: "", content: "" });
      setNotice(t("supportTicketSubmittedNotice", "user"));
      await loadTickets(created.id);
    } catch {
      setError(t("supportTicketSubmitFailed", "user"));
    } finally {
      setCreating(false);
    }
  };

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTicket) return;
    setReplying(true);
    setError("");
    setNotice("");
    try {
      const updated = await addSupportTicketMessage(selectedTicket.id, { message: replyMessage });
      setSelectedTicket(updated);
      setReplyMessage("");
      setNotice(t("supportTicketReplySubmitted", "user"));
      await loadTickets(updated.id);
    } catch {
      setError(t("supportTicketReplySubmitFailed", "user"));
    } finally {
      setReplying(false);
    }
  };

  const closeSelectedTicket = async () => {
    if (!selectedTicket) return;
    setClosing(true);
    setError("");
    setNotice("");
    try {
      const updated = await closeSupportTicket(selectedTicket.id);
      setSelectedTicket(updated);
      setNotice(t("supportTicketClosedNotice", "user"));
      await loadTickets(updated.id);
    } catch {
      setError(t("supportTicketCloseFailed", "user"));
    } finally {
      setClosing(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a0a0d] py-8 text-white lg:flex">
      <UserSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="w-full px-4 py-10 lg:w-4/5">
        <div className="mx-auto max-w-[1500px] space-y-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold">{pageTitle}</h1>
              <p className="mt-2 text-sm text-white/60">{t("supportTicketsDesc", "user")}</p>
            </div>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-10 rounded border border-white/10 bg-white/5 px-3 text-sm text-white outline-none"
            >
              {statusOptions.map((option) => (
                <option key={option.value || "ALL"} value={option.value} className="bg-[#111116]">
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {(notice || error) && (
            <div className={`rounded border px-4 py-3 text-sm ${error ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"}`}>
              {error || notice}
            </div>
          )}

          <section className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
            <div className="space-y-6">
              <form onSubmit={submitTicket} className="rounded-lg border border-white/10 bg-white/[0.03] p-5">
                <div className="mb-4">
                  <h2 className="text-lg font-semibold">{t("supportTicketCreateTitle", "user")}</h2>
                  <p className="mt-1 text-xs text-white/50">{t("supportTicketCreateDesc", "user")}</p>
                </div>
                <div className="space-y-4">
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">{t("supportTicketCategory", "user")}</span>
                    <select
                      value={createForm.category}
                      onChange={(event) => setCreateForm((form) => ({ ...form, category: event.target.value }))}
                      className="h-11 w-full rounded border border-white/10 bg-white/5 px-3 text-white outline-none"
                    >
                      {categories.map((category) => (
                        <option key={category.value} value={category.value} className="bg-[#111116]">
                          {categoryLabel(category.value, category.label, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">{t("supportTicketSubject", "user")}</span>
                    <input
                      value={createForm.subject}
                      onChange={(event) => setCreateForm((form) => ({ ...form, subject: event.target.value }))}
                      maxLength={255}
                      required
                      placeholder={t("supportTicketSubjectPlaceholder", "user")}
                      className="h-11 w-full rounded border border-white/10 bg-white/5 px-3 text-white outline-none placeholder:text-white/30"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">{t("supportTicketContent", "user")}</span>
                    <textarea
                      value={createForm.content}
                      onChange={(event) => setCreateForm((form) => ({ ...form, content: event.target.value }))}
                      maxLength={5000}
                      required
                      placeholder={t("supportTicketContentPlaceholder", "user")}
                      className="min-h-40 w-full resize-y rounded border border-white/10 bg-white/5 px-3 py-3 text-white outline-none placeholder:text-white/30"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={creating}
                    className="h-11 w-full rounded bg-amber-500 px-4 text-sm font-semibold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creating ? t("supportTicketSubmitting", "user") : t("supportTicketSubmit", "user")}
                  </button>
                </div>
              </form>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">{t("supportTicketMyTickets", "user")}</h2>
                  <span className="text-xs text-white/50">
                    {tickets.length} {t("supportTicketCountUnit", "user")}
                  </span>
                </div>
                {loading ? (
                  <div className="rounded border border-white/10 px-4 py-6 text-center text-sm text-white/50">
                    {t("supportTicketLoading", "user")}
                  </div>
                ) : tickets.length ? (
                  <div className="space-y-2">
                    {tickets.map((ticket) => (
                      <button
                        key={ticket.id}
                        type="button"
                        onClick={() => selectTicket(ticket.id)}
                        className={`w-full rounded border p-3 text-left transition ${
                          selectedTicket?.id === ticket.id
                            ? "border-amber-400/50 bg-amber-500/10"
                            : "border-white/10 bg-white/[0.03] hover:border-white/20"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{ticket.subject}</div>
                            <div className="mt-1 text-xs text-white/45">{ticket.ticket_no}</div>
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-xs ${statusClass(ticket.status)}`}>
                            {statusLabel(ticket.status, ticket.status_label, t)}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-white/45">
                          <span>{categoryLabel(ticket.category, ticket.category_label, t)}</span>
                          <span>{formatDate(ticket.updated_at, locale)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded border border-white/10 px-4 py-6 text-center text-sm text-white/50">
                    {t("supportTicketEmpty", "user")}
                  </div>
                )}
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-5">
              {detailLoading ? (
                <div className="py-16 text-center text-white/50">{t("supportTicketDetailLoading", "user")}</div>
              ) : selectedTicket ? (
                <div className="space-y-6">
                  <div className="flex flex-col gap-3 border-b border-white/10 pb-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="text-xs text-white/45">{selectedTicket.ticket_no}</div>
                      <h2 className="mt-2 text-xl font-bold">{selectedTicket.subject}</h2>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          {categoryLabel(selectedTicket.category, selectedTicket.category_label, t)}
                        </span>
                        <span className={`rounded-full border px-3 py-1 ${statusClass(selectedTicket.status)}`}>
                          {statusLabel(selectedTicket.status, selectedTicket.status_label, t)}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          {t("supportTicketUpdatedAt", "user")} {formatDate(selectedTicket.updated_at, locale)}
                        </span>
                      </div>
                    </div>
                    {!isSelectedClosed && (
                      <button
                        type="button"
                        onClick={closeSelectedTicket}
                        disabled={closing}
                        className="h-10 rounded border border-white/10 px-4 text-sm text-white/75 hover:bg-white/5 disabled:opacity-60"
                      >
                        {closing ? t("supportTicketClosing", "user") : t("supportTicketClose", "user")}
                      </button>
                    )}
                  </div>

                  <div className="space-y-3">
                    {(selectedTicket.messages || []).map((message) => (
                      <div
                        key={message.id}
                        className={`rounded-lg border p-4 ${
                          message.sender_type.toUpperCase() === "ADMIN"
                            ? "border-amber-400/25 bg-amber-500/10"
                            : "border-white/10 bg-white/[0.03]"
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-white/45">
                          <span>{messageSenderLabel(message.sender_type, t)}</span>
                          <span>{formatDate(message.created_at, locale)}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm leading-7 text-white/85">{message.message}</div>
                      </div>
                    ))}
                  </div>

                  {isSelectedClosed ? (
                    <div className="rounded border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/55">
                      {t("supportTicketClosedHint", "user")}
                    </div>
                  ) : (
                    <form onSubmit={submitReply} className="space-y-3 border-t border-white/10 pt-5">
                      <label className="block text-sm">
                        <span className="mb-2 block text-white/70">{t("supportTicketContinueSupplement", "user")}</span>
                        <textarea
                          value={replyMessage}
                          onChange={(event) => setReplyMessage(event.target.value)}
                          maxLength={5000}
                          required
                          placeholder={t("supportTicketReplyPlaceholder", "user")}
                          className="min-h-32 w-full resize-y rounded border border-white/10 bg-white/5 px-3 py-3 text-white outline-none placeholder:text-white/30"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={replying}
                        className="h-10 rounded bg-amber-500 px-5 text-sm font-semibold text-black transition hover:bg-amber-400 disabled:opacity-60"
                      >
                        {replying ? t("supportTicketSubmitting", "user") : t("supportTicketReplySubmit", "user")}
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <div className="py-16 text-center text-white/50">{t("supportTicketSelectOrCreate", "user")}</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
