import { request } from "../core/request";

export interface SendVerificationCodeIn {
  emailOrPhone?: string;
  type?: string;
  email?: string;
  phone?: string;
  scene?: "register" | "login" | "reset" | "reset_password" | string;
}

export interface ForgotPasswordIn {
  emailOrPhone?: string;
  captcha?: string;
  password?: string;
  confirmPassword?: string;
  email?: string;
  phone?: string;
  otp?: string;
  code?: string;
  newPassword?: string;
}

const isEmail = (value: string) => value.includes("@");

const normalizeAccount = (data: Pick<SendVerificationCodeIn, "emailOrPhone" | "email" | "phone">) => {
  const emailOrPhone = (data.emailOrPhone ?? "").trim();
  const email = (data.email ?? "").trim() || (emailOrPhone && isEmail(emailOrPhone) ? emailOrPhone : "");
  const phone = (data.phone ?? "").trim() || (emailOrPhone && !isEmail(emailOrPhone) ? emailOrPhone : "");
  return { email, phone };
};

export const sendVerificationCode = (data: SendVerificationCodeIn) => {
  const { email, phone } = normalizeAccount(data);
  const scene = (data.scene ?? data.type ?? "reset").trim();

  if (!email || phone) {
    throw new Error("仅支持邮箱找回密码");
  }

  return request<{ message?: string; dev_code?: string }>("/auth/otp/send", {
    method: "POST",
    body: JSON.stringify({ email, scene }),
  });
};

export const forgotPassword = (data: ForgotPasswordIn) => {
  const { email, phone } = normalizeAccount(data);
  const otp = (data.otp ?? data.code ?? data.captcha ?? "").trim();
  const newPassword = (data.newPassword ?? data.password ?? "").trim();
  const confirmPassword = (data.confirmPassword ?? "").trim();

  if (!email || phone) {
    throw new Error("仅支持邮箱找回密码");
  }

  return request<{ message?: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({
      email,
      otp,
      new_password: newPassword,
      confirm_password: confirmPassword,
    }),
  });
};
