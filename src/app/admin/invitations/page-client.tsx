"use client";

import Link from "next/link";
import { ArrowLeft, Check, CheckCircle2, Clock3, Copy, KeyRound, LayoutDashboard, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AccountServiceInvitation } from "@/lib/invitations/service";

type StatusFilter = "all" | "available" | "redeemed";

const FILTERS: Array<{ label: string; value: StatusFilter }> = [
  { label: "全部邀请码", value: "all" },
  { label: "未使用", value: "available" },
  { label: "已核销", value: "redeemed" },
];

export function InvitationConsole({ invitations }: { invitations: AccountServiceInvitation[] }) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [copiedCode, setCopiedCode] = useState("");
  const redeemedCount = invitations.filter((invitation) => invitation.redeemedAt !== null).length;
  const availableCount = invitations.length - redeemedCount;
  const visibleInvitations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return invitations.filter((invitation) => {
      const redeemed = invitation.redeemedAt !== null;
      if (filter === "available" && redeemed) return false;
      if (filter === "redeemed" && !redeemed) return false;
      return !normalizedQuery
        || invitation.code.toLowerCase().includes(normalizedQuery)
        || invitation.redeemedByUsername?.toLowerCase().includes(normalizedQuery);
    });
  }, [filter, invitations, query]);

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
              <span className="text-sm font-semibold">邀请码</span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-1.5 lg:grid-cols-1">
              <Stat label="邀请码总数" value={invitations.length} />
              <Stat label="当前可用" value={availableCount} tone="available" />
              <Stat label="已经核销" value={redeemedCount} tone="redeemed" />
            </div>

            <nav className="mt-3 grid gap-1 border-t border-white/8 pt-3" aria-label="邀请码筛选">
              {FILTERS.map(({ label, value }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={`flex h-8 items-center justify-between rounded-md px-2.5 text-xs font-medium transition ${
                    filter === value
                      ? "bg-cyan/[0.1] text-cyan"
                      : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  }`}
                >
                  {label}
                  <span className="tabular-nums">
                    {value === "all" ? invitations.length : value === "available" ? availableCount : redeemedCount}
                  </span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-white/[0.025]">
            <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
              <div>
                <h2 className="text-sm font-semibold">邀请码列表</h2>
                <p className="text-[11px] text-muted-foreground">当前显示 {visibleInvitations.length} 条</p>
              </div>
              <label className="flex h-8 w-full items-center gap-2 rounded-md border border-white/10 bg-black/20 px-2.5 text-xs focus-within:border-cyan/40 sm:w-64">
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
        </div>
      </div>
    </main>
  );
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
    <div className="flex items-center justify-between rounded-lg bg-black/15 px-2.5 py-2 lg:px-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${valueColor}`}>{value}</p>
    </div>
  );
}