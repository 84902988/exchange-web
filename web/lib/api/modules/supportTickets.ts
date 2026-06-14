import { apiGet, apiPost } from "@/lib/api/core/http";

export type SupportTicketStatus = "OPEN" | "IN_PROGRESS" | "REPLIED" | "CLOSED";

export type SupportTicketMessage = {
  id: number;
  ticket_id: number;
  sender_type: "USER" | "ADMIN" | string;
  sender_user_id: number | null;
  admin_user_id: number | null;
  message: string;
  created_at: string | null;
};

export type SupportTicket = {
  id: number;
  ticket_no: string;
  user_id: number;
  category: string;
  category_label: string;
  subject: string;
  content: string;
  status: SupportTicketStatus | string;
  status_label: string;
  status_badge: string;
  priority: string;
  priority_label: string;
  created_at: string | null;
  updated_at: string | null;
  last_reply_at: string | null;
  messages?: SupportTicketMessage[];
};

export type SupportTicketOption = {
  value: string;
  label: string;
  badge?: string;
};

export type SupportTicketListResponse = {
  items: SupportTicket[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
  categories: SupportTicketOption[];
  statuses: SupportTicketOption[];
};

export type CreateSupportTicketPayload = {
  category: string;
  subject: string;
  content: string;
};

export type AddSupportTicketMessagePayload = {
  message: string;
};

export async function listSupportTickets(status = ""): Promise<SupportTicketListResponse> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const suffix = params.toString();
  return apiGet<SupportTicketListResponse>(`/user/support-tickets${suffix ? `?${suffix}` : ""}`);
}

export async function createSupportTicket(payload: CreateSupportTicketPayload): Promise<SupportTicket> {
  return apiPost<SupportTicket, CreateSupportTicketPayload>("/user/support-tickets", payload);
}

export async function getSupportTicket(ticketId: number): Promise<SupportTicket> {
  return apiGet<SupportTicket>(`/user/support-tickets/${ticketId}`);
}

export async function addSupportTicketMessage(
  ticketId: number,
  payload: AddSupportTicketMessagePayload,
): Promise<SupportTicket> {
  return apiPost<SupportTicket, AddSupportTicketMessagePayload>(
    `/user/support-tickets/${ticketId}/messages`,
    payload,
  );
}

export async function closeSupportTicket(ticketId: number): Promise<SupportTicket> {
  return apiPost<SupportTicket, Record<string, never>>(`/user/support-tickets/${ticketId}/close`, {});
}
