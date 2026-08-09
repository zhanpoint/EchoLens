"use client";

import Link from "next/link";
import { ArrowLeft, Check, CheckCircle2, Clock3, Copy, KeyRound, LayoutDashboard, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AccountServiceInvitation } from "@/lib/invitations/service";
import type { UserFeedback } from "@/lib/feedback/service";

export function InvitationConsole({
  feedback,
  invitations,
}: {
  feedback: UserFeedback[];
  invitations: AccountServiceInvitation[];
}) {
  const [panel, setPanel] = useState<"feedback" | "invitations">("invitations");
  const [query, setQuery] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const redeemedCount = invitations.filter((invitation) => invitation.redeemedAt !== null).length;
  const availableCount = invitations.length - redeemedCount;
  const visibleInvitations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return invitations.filter((invitation) => {
      return !normalizedQuery
        || invitation.code.toLowerCase().includes(normalizedQuery)
        || invitation.redeemedByUsername?.toLowerCase().includes(normalizedQuery);
    });
  }, [invitations, query]);

  async function copyCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode((current) => current === code ? "" : current), 1500);
  }

  return (
    <main className="h-dvh overflow-hidden bg-background px-3 py-4 text-foreground sm:px-5 lg:px-7">
      <div className="mx-auto flex h-full max-w-7xl flex-col">
        <header className="mb-4 flex shrink-0 items-center gap-3 px-1">
          <Link
            href="/"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/35"
            aria-label="返回 EchoLens"
            title="返回 EchoLens"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          <h1 className="text-2xl font-semibold">控制台</h1>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] items-stretch gap-3 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="overflow-y-auto rounded-xl border border-white/10 bg-white/[0.025] p-3">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <LayoutDashboard className="size-4 text-cyan" aria-hidden="true" />
              <span className="text-sm font-semibold">控制台</span>
            </div>

            <div className="mt-3 grid gap-1">
              <button
                type="button"
                onClick={() => setPanel("invitations")}
                className={`flex h-9 items-center justify-between rounded-md px-2.5 text-left text-sm transition ${panel === "invitations" ? "bg-cyan/[0.12] text-cyan" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}`}
              >
                <span>邀请码</span>
                <span className="text-xs tabular-nums">{invitations.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setPanel("feedback")}
                className={`flex h-9 items-center justify-between rounded-md px-2.5 text-left text-sm transition ${panel === "feedback" ? "bg-cyan/[0.12] text-cyan" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}`}
              >
                <span>反馈</span>
                <span className="text-xs tabular-nums">{feedback.length}</span>
              </button>
            </div>

          </aside>

          {panel === "invitations" ? (
          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
            <div className="relative flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
              <h2 className="shrink-0 text-sm font-semibold">邀请码列表</h2>
              <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 lg:flex">
                <Stat label="邀请码总数" value={invitations.length} />
                <Stat label="当前可用" value={availableCount} tone="available" />
                <Stat label="已经核销" value={redeemedCount} tone="redeemed" />
              </div>
              <label className="ml-auto flex h-8 w-full items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2.5 text-xs focus-within:border-cyan/40 sm:w-64">
                <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索邀请码或核销用户"
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>

            <div className="hidden shrink-0 grid-cols-[minmax(13rem,1.4fr)_5rem_minmax(7rem,0.8fr)_9rem_2rem] gap-3 border-b border-white/[0.07] px-3 py-2 text-[11px] font-medium text-muted-foreground sm:grid">
              <span>邀请码</span>
              <span>状态</span>
              <span>核销用户</span>
              <span>核销时间</span>
              <span className="sr-only">操作</span>
            </div>

            <div className="min-h-0 flex-1 divide-y divide-white/[0.06] overflow-y-auto overscroll-contain">
              {visibleInvitations.map((invitation) => {
                const redeemed = invitation.redeemedAt !== null;
                return (
                  <article
                    key={invitation.code}
                    className="relative grid gap-1.5 px-3 py-2.5 pr-12 transition hover:bg-white/[0.025] sm:grid-cols-[minmax(13rem,1.4fr)_5rem_minmax(7rem,0.8fr)_9rem_2rem] sm:items-center sm:gap-3 sm:py-2 sm:pr-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <KeyRound className={`size-3.5 shrink-0 ${redeemed ? "text-muted-foreground" : "text-amber"}`} aria-hidden="true" />
                      <code className="truncate text-xs font-semibold tracking-wide">{invitation.code}</code>
                    </div>
                    <div className={`flex items-center gap-1.5 text-[11px] ${redeemed ? "text-muted-foreground" : "text-emerald-400"}`}>
                      {redeemed ? <CheckCircle2 className="size-3" /> : <Clock3 className="size-3" />}
                      {redeemed ? "已核销" : "未使用"}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{invitation.redeemedByUsername ?? "—"}</p>
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {invitation.redeemedAt ? new Date(invitation.redeemedAt).toLocaleString("zh-CN") : "—"}
                    </p>
                    <button
                      type="button"
                      onClick={() => void copyCode(invitation.code)}
                      className="absolute right-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-cyan sm:static"
                      aria-label={`复制 ${invitation.code}`}
                    >
                      {copiedCode === invitation.code ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </button>
                  </article>
                );
              })}
              {visibleInvitations.length === 0 ? (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">没有匹配的邀请码。</p>
              ) : null}
            </div>
          </section>
          ) : <FeedbackPanel initialFeedback={feedback} />}
        </div>
      </div>
    </main>
  );
}

function FeedbackPanel({ initialFeedback }: { initialFeedback: UserFeedback[] }) {
  const [feedback, setFeedback] = useState(initialFeedback);
  const openFeedbackCount = feedback.filter((item) => item.status === "open").length;
  const resolvedFeedbackCount = feedback.length - openFeedbackCount;
  const [query, setQuery] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [updatingId, setUpdatingId] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFeedback = feedback.filter((item) => !normalizedQuery
    || item.content.toLowerCase().includes(normalizedQuery)
    || item.username.toLowerCase().includes(normalizedQuery)
    || item.userEmail.toLowerCase().includes(normalizedQuery)
    || feedbackTypeLabel(item.type).includes(normalizedQuery));

  async function updateStatus(id: string, status: UserFeedback["status"]) {
    setUpdatingId(id);
    setUpdateError("");
    try {
      const response = await fetch("/api/admin/feedback", {
        body: JSON.stringify({ id, status }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => null) as { feedback?: UserFeedback } | null;
      if (!response.ok || !payload?.feedback) {
        throw new Error("反馈状态更新失败。");
      }
      setFeedback((current) => current.map((item) => item.id === id ? payload.feedback! : item));
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "反馈状态更新失败。");
    } finally {
      setUpdatingId("");
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
      <div className="relative flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
        <h2 className="shrink-0 text-sm font-semibold">用户反馈</h2>
        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-2 lg:flex">
          <Stat label="待处理" value={openFeedbackCount} tone="available" />
          <Stat label="已处理" value={resolvedFeedbackCount} tone="redeemed" />
        </div>
        <label className="ml-auto flex h-8 w-full items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2.5 text-xs focus-within:border-cyan/40 sm:w-64">
          <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索内容、用户或邮箱"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      {updateError ? <p className="shrink-0 px-3 py-2 text-xs font-medium text-destructive">{updateError}</p> : null}
      <div className="hidden shrink-0 grid-cols-[minmax(14rem,1.5fr)_5.5rem_minmax(8rem,0.9fr)_9rem_5rem_7rem] gap-3 border-b border-white/[0.07] px-3 py-2 text-[11px] font-medium text-muted-foreground sm:grid">
        <span>反馈内容</span>
        <span>类型</span>
        <span>提交用户</span>
        <span>提交时间</span>
        <span>状态</span>
        <span className="text-right">操作</span>
      </div>
      <div className="min-h-0 flex-1 divide-y divide-white/[0.06] overflow-y-auto overscroll-contain">
        {visibleFeedback.map((item) => {
          const resolved = item.status === "resolved";
          const updating = updatingId === item.id;
          return (
            <article
              key={item.id}
              className="grid gap-1.5 px-3 py-3 transition hover:bg-white/[0.025] sm:grid-cols-[minmax(14rem,1.5fr)_5.5rem_minmax(8rem,0.9fr)_9rem_5rem_7rem] sm:items-center sm:gap-3 sm:py-2.5"
            >
              <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-5 text-foreground sm:line-clamp-2">
                {item.content}
              </p>
              <span className="w-fit rounded bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {feedbackTypeLabel(item.type)}
              </span>
              <span className="truncate text-xs text-muted-foreground" title={item.userEmail}>
                {item.username} · {item.userEmail}
              </span>
              <time className="text-[11px] tabular-nums text-muted-foreground">
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </time>
              <span className={resolved ? "text-xs text-muted-foreground" : "text-xs font-semibold text-amber"}>
                {resolved ? "已处理" : "待处理"}
              </span>
              <button
                type="button"
                disabled={updating}
                onClick={() => void updateStatus(item.id, resolved ? "open" : "resolved")}
                className={`inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 sm:justify-self-end ${resolved ? "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" : "bg-cyan/[0.12] text-cyan hover:bg-cyan/[0.2]"}`}
              >
                {updating ? <Clock3 className="size-3.5 animate-spin" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
                {resolved ? "恢复待处理" : "标记已处理"}
              </button>
            </article>
          );
        })}
        {visibleFeedback.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">没有匹配的反馈。</p>
        ) : null}
      </div>
    </section>
  );
}

function feedbackTypeLabel(type: UserFeedback["type"]): string {
  return ({ bug: "问题反馈", feature: "功能建议", other: "其他" } as const)[type ?? "other"];
}

function Stat({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "available" | "default" | "redeemed";
  value: number;
}) {
  const valueColor = tone === "available" ? "text-emerald-400" : tone === "redeemed" ? "text-amber" : "text-cyan";
  return (
    <div className="inline-flex h-8 items-center gap-2 rounded-md bg-black/15 px-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${valueColor}`}>{value}</p>
    </div>
  );
}