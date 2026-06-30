"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type AuthMode = "forgot" | "login" | "register";
type LoginMethod = "code" | "password";
type FieldName = Exclude<keyof FormState, "acceptedLegal">;

type ApiMessage = {
  error?: string;
  expiresIn?: number;
  message?: string;
  retryAfter?: number;
  user?: {
    email: string;
    username: string;
  };
};

type FormState = {
  acceptedLegal: boolean;
  code: string;
  confirmPassword: string;
  email: string;
  identifier: string;
  password: string;
  username: string;
};

const initialState: FormState = {
  acceptedLegal: false,
  code: "",
  confirmPassword: "",
  email: "",
  identifier: "",
  password: "",
  username: "",
};

const AUTH_DESCRIPTION = "为您提供个性化服务和更好的体验。";
const MODE_COPY: Record<AuthMode, { body: string; title: string }> = {
  forgot: { body: AUTH_DESCRIPTION, title: "重置密码" },
  login: { body: AUTH_DESCRIPTION, title: "登录" },
  register: { body: AUTH_DESCRIPTION, title: "注册" },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,24}$/u;

export function AuthFlow({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialState);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("password");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const copy = MODE_COPY[mode];
  const fieldErrors = useMemo(() => getFieldErrors(form, mode, loginMethod), [form, loginMethod, mode]);
  const hasBlockingErrors = Object.values(fieldErrors).some(Boolean);
  const canSubmit = (mode === "forgot" || form.acceptedLegal) && !hasBlockingErrors;
  const canSendCode = useMemo(
    () =>
      (mode === "register" || mode === "forgot" || loginMethod === "code") &&
      !validateEmail(form.email) &&
      cooldown <= 0 &&
      !sendingCode,
    [cooldown, form.email, loginMethod, mode, sendingCode],
  );

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setCooldown((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
    setNotice("");
  }

  function fieldError(field: FieldName): string | undefined {
    return submitted || form[field] ? fieldErrors[field] : undefined;
  }

  function switchLoginMethod(nextMethod: LoginMethod) {
    setLoginMethod(nextMethod);
    setError("");
    setNotice("");
    setSubmitted(false);
  }

  async function sendCode() {
    if (!canSendCode) {
      return;
    }

    setSendingCode(true);
    setError("");
    setNotice("");

    try {
      const payload = await postJson("/api/auth/send-code", {
        email: form.email,
        purpose: mode === "login" ? "login" : mode === "forgot" ? "reset" : "signup",
      });
      setNotice(payload.message ?? "验证码已发送。");
      setCooldown(payload.retryAfter ?? 60);
    } catch (sendError) {
      setError(readError(sendError));
    } finally {
      setSendingCode(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (!canSubmit) {
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");

    try {
      if (mode === "login") {
        await postJson(
          "/api/auth/login",
          loginMethod === "code"
            ? {
                acceptedLegal: form.acceptedLegal,
                code: form.code,
                email: form.email,
                method: "code",
              }
            : {
                acceptedLegal: form.acceptedLegal,
                identifier: form.identifier,
                method: "password",
                password: form.password,
              },
        );
        router.replace(getSafeNextPath());
        router.refresh();
        return;
      }

      if (mode === "register") {
        await postJson("/api/auth/register", {
          acceptedLegal: form.acceptedLegal,
          code: form.code,
          confirmPassword: form.confirmPassword,
          email: form.email,
          password: form.password,
          username: form.username,
        });
        router.replace("/");
        router.refresh();
        return;
      }

      await postJson("/api/auth/reset-password", {
        code: form.code,
        confirmPassword: form.confirmPassword,
        email: form.email,
        password: form.password,
      });
      router.replace("/login");
      router.refresh();
    } catch (submitError) {
      setError(readError(submitError));
    } finally {
      setLoading(false);
    }
  }

  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/");
  }

  return (
    <main className="app-shell min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <div className="relative z-10 min-h-[100dvh]">
        <Link
          href="/"
          className="absolute left-4 top-4 flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-md px-2 py-1 text-foreground transition hover:text-cyan sm:left-6 sm:top-6"
          aria-label="返回 EchoLens 首页"
        >
          <Image
            src="/echolens-logo.svg"
            alt=""
            width={38}
            height={34}
            className="h-9 w-10 shrink-0 object-contain"
            priority
          />
          <span className="text-lg font-semibold">EchoLens</span>
        </Link>

        <div className="mx-auto flex min-h-[100dvh] w-full max-w-2xl items-start justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-24 sm:items-center sm:px-6 sm:py-20">
          <section className="flex w-full items-center justify-center">
            <div className="relative w-full max-w-lg rounded-lg border border-white/12 bg-[linear-gradient(180deg,rgb(255_255_255_/_0.07),rgb(255_255_255_/_0.035))] p-5 shadow-[0_24px_80px_rgb(0_0_0_/_0.34),inset_0_1px_0_rgb(255_255_255_/_0.08)] backdrop-blur-xl sm:p-6">
              <button
                type="button"
                onClick={goBack}
                className="absolute left-4 top-4 inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan active:scale-[0.96]"
                aria-label="返回上一步"
                title="返回上一步"
              >
                <ArrowLeft className="size-6" aria-hidden="true" strokeWidth={2.35} />
              </button>

              <div className="mb-6 text-center">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">{copy.title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.body}</p>
              </div>

              <form onSubmit={submit} className="grid gap-4">
                {mode === "register" ? (
                  <TextField
                    autoComplete="username"
                    error={fieldError("username")}
                    icon={<UserRound className="size-4" />}
                    label="用户名"
                    onChange={(value) => update("username", value)}
                    placeholder="输入用户名"
                    value={form.username}
                  />
                ) : null}

                {mode === "login" ? (
                  <>
                    <LoginMethodTabs method={loginMethod} onChange={switchLoginMethod} />
                    {loginMethod === "password" ? (
                      <TextField
                        autoComplete="username"
                        error={fieldError("identifier")}
                        icon={<UserRound className="size-4" />}
                        label="用户名"
                        onChange={(value) => update("identifier", value)}
                        placeholder="输入用户名"
                        value={form.identifier}
                      />
                    ) : (
                      <TextField
                        autoComplete="email"
                        error={fieldError("email")}
                        icon={<Mail className="size-4" />}
                        label="邮箱"
                        onChange={(value) => update("email", value)}
                        placeholder="name@example.com"
                        type="email"
                        value={form.email}
                      />
                    )}
                  </>
                ) : (
                  <TextField
                    autoComplete="email"
                    error={fieldError("email")}
                    icon={<Mail className="size-4" />}
                    label="邮箱"
                    onChange={(value) => update("email", value)}
                    placeholder="name@example.com"
                    type="email"
                    value={form.email}
                  />
                )}

                {mode !== "login" || loginMethod === "password" ? (
                  <PasswordField
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    error={fieldError("password")}
                    label={mode === "forgot" ? "新密码" : "密码"}
                    onChange={(value) => update("password", value)}
                    placeholder={mode === "login" ? "输入密码" : "至少 8 个字符"}
                    value={form.password}
                  />
                ) : null}

                {mode !== "login" ? (
                  <PasswordField
                    autoComplete="new-password"
                    error={fieldError("confirmPassword")}
                    label="确认密码"
                    onChange={(value) => update("confirmPassword", value)}
                    placeholder="再次输入密码"
                    value={form.confirmPassword}
                  />
                ) : null}

                {mode !== "login" || loginMethod === "code" ? (
                  <CodeField
                    canSend={canSendCode}
                    code={form.code}
                    cooldown={cooldown}
                    error={fieldError("code")}
                    onChange={(value) => update("code", value)}
                    onSend={() => void sendCode()}
                    sending={sendingCode}
                  />
                ) : null}

                {mode !== "forgot" ? (
                  <div className="grid gap-3 pt-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <LegalConsent checked={form.acceptedLegal} onChange={(value) => update("acceptedLegal", value)} />
                    <ModeLinks mode={mode} />
                  </div>
                ) : (
                  <div className="flex justify-end pt-1">
                    <ModeLinks mode={mode} />
                  </div>
                )}

                {error ? <p className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-red-200">{error}</p> : null}
                {notice ? <p className="rounded-md border border-cyan/20 bg-cyan/[0.08] px-3 py-2 text-sm text-cyan">{notice}</p> : null}

                <button
                  type="submit"
                  disabled={loading || !canSubmit}
                  className={cn(
                    "mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition active:scale-[0.98]",
                    canSubmit
                      ? "bg-cyan text-black hover:brightness-110 disabled:cursor-wait disabled:opacity-65"
                      : "cursor-not-allowed border border-white/12 bg-muted text-muted-foreground",
                  )}
                >
                  {loading ? <Loader2 className="size-4 animate-spin" /> : <SubmitIcon mode={mode} />}
                  {submitLabel(mode)}
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function ModeLinks({ mode }: { mode: AuthMode }) {
  if (mode === "login") {
    return (
      <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground sm:justify-end">
        <span>
          没有账号？
          <Link className="font-semibold text-cyan hover:text-amber" href="/register">
            注册
          </Link>
        </span>
        <Link className="font-semibold text-cyan hover:text-amber" href="/forgot-password">
          忘记密码？
        </Link>
      </div>
    );
  }

  if (mode === "forgot") {
    return (
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          已有账号？
          <Link className="font-semibold text-cyan hover:text-amber" href="/login">
            登录
          </Link>
        </span>
        <span>
          没有账号？
          <Link className="font-semibold text-cyan hover:text-amber" href="/register">
            注册
          </Link>
        </span>
      </div>
    );
  }

  return (
    <p className="shrink-0 text-xs text-muted-foreground sm:text-right">
      已有账号？
      <Link className="font-semibold text-cyan hover:text-amber" href="/login">
        登录
      </Link>
    </p>
  );
}

function LoginMethodTabs({
  method,
  onChange,
}: {
  method: LoginMethod;
  onChange: (method: LoginMethod) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-md border border-white/12 bg-white/[0.045] p-1">
      {[
        { label: "用户名密码", value: "password" as const },
        { label: "邮箱验证码", value: "code" as const },
      ].map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          className={cn(
            "h-9 rounded-[0.38rem] text-sm font-semibold transition active:scale-[0.98]",
            method === item.value
              ? "bg-cyan text-black shadow-[inset_0_1px_0_rgb(255_255_255_/_0.35)]"
              : "text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function TextField({
  autoComplete,
  error,
  icon,
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  autoComplete: string;
  error?: string;
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: string;
  value: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <span
        className={cn(
          "flex h-11 items-center gap-2 rounded-md border bg-white/[0.055] px-3 text-muted-foreground transition focus-within:ring-2",
          error
            ? "border-destructive/65 focus-within:border-destructive/80 focus-within:ring-destructive/15"
            : "border-white/15 focus-within:border-cyan/60 focus-within:ring-cyan/15",
        )}
      >
        {icon}
        <input
          autoComplete={autoComplete}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          required
          type={type}
          value={value}
        />
      </span>
      {error ? <p className="text-xs leading-5 text-red-200">{error}</p> : null}
    </label>
  );
}

function PasswordField({
  autoComplete,
  error,
  label,
  onChange,
  placeholder,
  value,
}: {
  autoComplete: string;
  error?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <span
        className={cn(
          "flex h-11 items-center gap-2 rounded-md border bg-white/[0.055] px-3 text-muted-foreground transition focus-within:ring-2",
          error
            ? "border-destructive/65 focus-within:border-destructive/80 focus-within:ring-destructive/15"
            : "border-white/15 focus-within:border-cyan/60 focus-within:ring-cyan/15",
        )}
      >
        <KeyRound className="size-4" />
        <input
          autoComplete={autoComplete}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          required
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md transition hover:bg-white/10 hover:text-cyan"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? "隐藏密码" : "显示密码"}
          title={visible ? "隐藏密码" : "显示密码"}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </span>
      {error ? <p className="text-xs leading-5 text-red-200">{error}</p> : null}
    </label>
  );
}

function CodeField({
  canSend,
  code,
  cooldown,
  error,
  onChange,
  onSend,
  sending,
}: {
  canSend: boolean;
  code: string;
  cooldown: number;
  error?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  return (
    <label className="grid gap-2">
      <span className="text-sm font-semibold text-foreground">邮箱验证码</span>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input
          autoComplete="one-time-code"
          className={cn(
            "h-11 min-w-0 rounded-md border bg-white/[0.055] px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:ring-2",
            error
              ? "border-destructive/65 focus:border-destructive/80 focus:ring-destructive/15"
              : "border-white/15 focus:border-cyan/60 focus:ring-cyan/15",
          )}
          inputMode="numeric"
          maxLength={6}
          onChange={(event) => onChange(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="输入 6 位验证码"
          required
          value={code}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className={cn(
            "inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-white/12 bg-white/[0.065] px-3 text-sm font-semibold text-foreground transition hover:border-cyan/35 hover:bg-cyan/[0.08] hover:text-cyan active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-55 sm:w-auto sm:min-w-28",
            sending ? "disabled:cursor-wait" : "",
          )}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : null}
          {cooldown > 0 ? `${cooldown}s` : "发送验证码"}
        </button>
      </div>
      {error ? <p className="text-xs leading-5 text-red-200">{error}</p> : null}
    </label>
  );
}

function LegalConsent({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 text-xs leading-5 text-muted-foreground">
      <span className="relative shrink-0">
        <input
          checked={checked}
          className="peer absolute inset-0 z-10 cursor-pointer opacity-0"
          onChange={(event) => onChange(event.currentTarget.checked)}
          required
          type="checkbox"
        />
        <span className="flex size-[1.05rem] items-center justify-center rounded-[0.28rem] border border-white/25 bg-white/[0.03] transition peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/20 peer-checked:border-cyan/80 peer-checked:[&_svg]:opacity-100">
          <Check className="size-[0.82rem] text-cyan opacity-0" strokeWidth={3.2} />
        </span>
      </span>
      <span className="min-w-0">
        我已阅读并同意{" "}
        <Link className="font-semibold text-cyan hover:text-amber" href="/terms" target="_blank" rel="noreferrer">
          用户协议
        </Link>{" "}
        和{" "}
        <Link className="font-semibold text-cyan hover:text-amber" href="/privacy" target="_blank" rel="noreferrer">
          隐私政策
        </Link>
        。
      </span>
    </label>
  );
}

function getFieldErrors(
  form: FormState,
  mode: AuthMode,
  loginMethod: LoginMethod,
): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};

  if (mode === "register") {
    errors.username = validateUsername(form.username);
  }

  if (mode === "login" && loginMethod === "password") {
    errors.identifier = validateIdentifier(form.identifier);
    errors.password = validateLoginPassword(form.password);
  } else {
    errors.email = validateEmail(form.email);
    errors.code = validateCode(form.code);
  }

  if (mode !== "login") {
    errors.password = validateStrongPassword(form.password);
    errors.confirmPassword = validateConfirmPassword(form.confirmPassword, form.password);
  }

  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as Partial<
    Record<FieldName, string>
  >;
}

function validateUsername(value: string): string | undefined {
  const username = value.trim();
  if (!username) {
    return "请输入用户名。";
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "用户名需为 3 到 24 位，可包含中文、字母、数字、下划线或短横线。";
  }
}

function validateIdentifier(value: string): string | undefined {
  const identifier = value.trim();
  if (!identifier) {
    return "请输入用户名。";
  }
  if (identifier.includes("@") && validateEmail(identifier)) {
    return "用户名登录不支持邮箱，请改用邮箱验证码登录。";
  }
}

function validateEmail(value: string): string | undefined {
  const email = value.trim();
  if (!email) {
    return "请输入邮箱。";
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    return "请输入有效邮箱地址。";
  }
}

function validateLoginPassword(value: string): string | undefined {
  if (!value) {
    return "请输入密码。";
  }
  if (value.length > 128) {
    return "密码不能超过 128 个字符。";
  }
}

function validateStrongPassword(value: string): string | undefined {
  if (!value) {
    return "请输入密码。";
  }
  if (value.length < 8) {
    return "密码至少需要 8 个字符。";
  }
  if (value.length > 128) {
    return "密码不能超过 128 个字符。";
  }
  const typeCount = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;

  if (typeCount < 3) {
    return "密码需包含至少 3 种字符类型。";
  }
}

function validateConfirmPassword(value: string, password: string): string | undefined {
  if (!value) {
    return "请再次输入密码。";
  }
  if (value !== password) {
    return "两次输入的密码不一致。";
  }
}

function validateCode(value: string): string | undefined {
  if (!value) {
    return "请输入验证码。";
  }
  if (!/^\d{6}$/.test(value)) {
    return "请输入 6 位数字验证码。";
  }
}

function SubmitIcon({ mode }: { mode: AuthMode }) {
  if (mode === "forgot") {
    return <ShieldCheck className="size-4" />;
  }
  return mode === "login" ? <ArrowRight className="size-4" /> : <UserRound className="size-4" />;
}

function submitLabel(mode: AuthMode): string {
  if (mode === "forgot") {
    return "重置密码";
  }
  return mode === "login" ? "登录" : "创建账号";
}

function getSafeNextPath(): string {
  if (typeof window === "undefined") {
    return "/";
  }

  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) {
    return "/";
  }

  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}

async function postJson(url: string, body: unknown): Promise<ApiMessage> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = (await response.json().catch(() => ({}))) as ApiMessage;
  if (!response.ok) {
    throw new Error(payload.error || "请求失败。");
  }
  return payload;
}

function readError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "请求失败，请稍后重试。";
  }
  if (error.name === "AbortError") {
    return "请求超时，请稍后重试。";
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(error.message)) {
    return "网络连接异常，请检查网络后重试。";
  }

  return error.message || "请求失败，请稍后重试。";
}
