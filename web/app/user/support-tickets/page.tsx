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
  { value: "ACCOUNT", label: "账户问题" },
  { value: "KYC", label: "身份认证" },
  { value: "DEPOSIT_WITHDRAW", label: "充值提现" },
  { value: "TRADING", label: "交易问题" },
  { value: "SECURITY", label: "安全问题" },
  { value: "OTHER", label: "其他" },
];

const FALLBACK_STATUSES: SupportTicketOption[] = [
  { value: "OPEN", label: "待处理", badge: "warning" },
  { value: "IN_PROGRESS", label: "处理中", badge: "info" },
  { value: "REPLIED", label: "已回复", badge: "success" },
  { value: "CLOSED", label: "已关闭", badge: "muted" },
];

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function statusClass(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "REPLIED") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (normalized === "IN_PROGRESS") return "border-sky-400/30 bg-sky-500/10 text-sky-200";
  if (normalized === "CLOSED") return "border-white/15 bg-white/5 text-white/50";
  return "border-amber-400/30 bg-amber-500/10 text-amber-200";
}

function messageSenderLabel(senderType: string) {
  return senderType.toUpperCase() === "ADMIN" ? "客服回复" : "我的补充";
}

export default function SupportTicketsPage() {
  const { t } = useLocaleContext();
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
    return [{ value: "", label: "全部状态" }, ...statuses];
  }, [statuses]);

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
            setError("工单详情加载失败，请稍后重试。");
          }
        } else {
          setSelectedTicket(null);
        }
      } catch {
        setTickets([]);
        setSelectedTicket(null);
        setError("工单加载失败，请稍后重试。");
      } finally {
        setLoading(false);
      }
    },
    [selectedTicket?.id, statusFilter],
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
            setError("工单详情加载失败，请稍后重试。");
          }
        } else {
          setSelectedTicket(null);
        }
      } catch {
        if (!alive) return;
        setTickets([]);
        setSelectedTicket(null);
        setError("工单加载失败，请稍后重试。");
      } finally {
        if (alive) setLoading(false);
      }
    }
    run();
    return () => {
      alive = false;
    };
  }, [statusFilter]);

  const selectTicket = async (ticketId: number) => {
    setDetailLoading(true);
    setError("");
    try {
      setSelectedTicket(await getSupportTicket(ticketId));
    } catch {
      setSelectedTicket(null);
      setError("工单详情加载失败，请稍后重试。");
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
      setNotice("工单已提交，客服会尽快处理。");
      await loadTickets(created.id);
    } catch {
      setError("提交工单失败，请检查标题和问题描述后重试。");
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
      setNotice("补充内容已提交。");
      await loadTickets(updated.id);
    } catch {
      setError("提交补充内容失败，已关闭工单不能继续回复。");
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
      setNotice("工单已关闭。");
      await loadTickets(updated.id);
    } catch {
      setError("关闭工单失败，请稍后重试。");
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
              <p className="mt-2 text-sm text-white/60">提交问题、查看客服回复，并跟进你的历史工单。</p>
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
                  <h2 className="text-lg font-semibold">新建工单</h2>
                  <p className="mt-1 text-xs text-white/50">请尽量描述清楚问题、账户、交易或链上信息。</p>
                </div>
                <div className="space-y-4">
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">分类</span>
                    <select
                      value={createForm.category}
                      onChange={(event) => setCreateForm((form) => ({ ...form, category: event.target.value }))}
                      className="h-11 w-full rounded border border-white/10 bg-white/5 px-3 text-white outline-none"
                    >
                      {categories.map((category) => (
                        <option key={category.value} value={category.value} className="bg-[#111116]">
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">标题</span>
                    <input
                      value={createForm.subject}
                      onChange={(event) => setCreateForm((form) => ({ ...form, subject: event.target.value }))}
                      maxLength={255}
                      required
                      placeholder="例如：提现长时间未到账"
                      className="h-11 w-full rounded border border-white/10 bg-white/5 px-3 text-white outline-none placeholder:text-white/30"
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-2 block text-white/70">问题描述</span>
                    <textarea
                      value={createForm.content}
                      onChange={(event) => setCreateForm((form) => ({ ...form, content: event.target.value }))}
                      maxLength={5000}
                      required
                      placeholder="请输入详细问题描述"
                      className="min-h-40 w-full resize-y rounded border border-white/10 bg-white/5 px-3 py-3 text-white outline-none placeholder:text-white/30"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={creating}
                    className="h-11 w-full rounded bg-amber-500 px-4 text-sm font-semibold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {creating ? "提交中..." : "提交工单"}
                  </button>
                </div>
              </form>

              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-semibold">我的工单</h2>
                  <span className="text-xs text-white/50">{tickets.length} 条</span>
                </div>
                {loading ? (
                  <div className="rounded border border-white/10 px-4 py-6 text-center text-sm text-white/50">加载中...</div>
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
                            {ticket.status_label}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-white/45">
                          <span>{ticket.category_label}</span>
                          <span>{formatDate(ticket.updated_at)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded border border-white/10 px-4 py-6 text-center text-sm text-white/50">暂无工单</div>
                )}
              </div>
            </div>

            <div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-5">
              {detailLoading ? (
                <div className="py-16 text-center text-white/50">详情加载中...</div>
              ) : selectedTicket ? (
                <div className="space-y-6">
                  <div className="flex flex-col gap-3 border-b border-white/10 pb-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="text-xs text-white/45">{selectedTicket.ticket_no}</div>
                      <h2 className="mt-2 text-xl font-bold">{selectedTicket.subject}</h2>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{selectedTicket.category_label}</span>
                        <span className={`rounded-full border px-3 py-1 ${statusClass(selectedTicket.status)}`}>
                          {selectedTicket.status_label}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          更新于 {formatDate(selectedTicket.updated_at)}
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
                        {closing ? "关闭中..." : "关闭工单"}
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
                          <span>{messageSenderLabel(message.sender_type)}</span>
                          <span>{formatDate(message.created_at)}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm leading-7 text-white/85">{message.message}</div>
                      </div>
                    ))}
                  </div>

                  {isSelectedClosed ? (
                    <div className="rounded border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/55">
                      该工单已关闭，如需继续咨询请提交新的支持工单。
                    </div>
                  ) : (
                    <form onSubmit={submitReply} className="space-y-3 border-t border-white/10 pt-5">
                      <label className="block text-sm">
                        <span className="mb-2 block text-white/70">继续补充</span>
                        <textarea
                          value={replyMessage}
                          onChange={(event) => setReplyMessage(event.target.value)}
                          maxLength={5000}
                          required
                          placeholder="补充问题或回复客服"
                          className="min-h-32 w-full resize-y rounded border border-white/10 bg-white/5 px-3 py-3 text-white outline-none placeholder:text-white/30"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={replying}
                        className="h-10 rounded bg-amber-500 px-5 text-sm font-semibold text-black transition hover:bg-amber-400 disabled:opacity-60"
                      >
                        {replying ? "提交中..." : "提交补充"}
                      </button>
                    </form>
                  )}
                </div>
              ) : (
                <div className="py-16 text-center text-white/50">请选择左侧工单，或提交一个新的支持工单。</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
