"use client";

import { Check, KeyRound, Loader2, X } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

const SUPPORT_QQ = "2182392144";
const INVITATION_FEATURES = ["评论采集", "收藏作品", "关注列表", "账号凭证管理"] as const;

type InvitationDialogProps = {
  invitationRedeemed: boolean;
  onClose: () => void;
  onRedeemed: () => void;
};

export function InvitationDialog({ invitationRedeemed, onClose, onRedeemed }: InvitationDialogProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function redeem() {
    if (!code.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/invitations/redeem", {
        body: JSON.stringify({ code }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error || "邀请码核验失败。");
      onRedeemed();
    } catch (redeemError) {
      setError(redeemError instanceof Error ? redeemError.message : "邀请码核验失败。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copySupport() {
    await navigator.clipboard.writeText(SUPPORT_QQ);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/65 p-3 backdrop-blur-sm sm:items-center" role="presentation" onMouseDown={onClose}>
      <section
        className="w-full max-w-lg rounded-2xl border border-cyan/20 bg-background p-5 text-foreground shadow-[0_24px_80px_rgb(0_0_0_/_0.65),0_0_0_1px_rgb(34_211_238_/_0.04)] sm:p-7"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invitation-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-cyan/10 text-cyan">
            <KeyRound className="size-5" aria-hidden="true" />
          </span>
          <h2 id="invitation-dialog-title" className="min-w-0 flex-1 text-xl font-semibold">输入邀请码</h2>
          <button type="button" onClick={onClose} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition duration-150 hover:bg-cyan/10 hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/50 active:scale-95" aria-label="关闭">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-5">
          <p className="text-xs font-medium text-muted-foreground">开通功能</p>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            {INVITATION_FEATURES.map((feature) => (
              <div key={feature} className="flex items-center gap-2 rounded-lg border border-cyan/10 bg-cyan/[0.035] px-3 py-2">
                <Check className="size-3.5 shrink-0 text-cyan" aria-hidden="true" />
                {feature}
              </div>
            ))}
          </div>
        </div>

        {invitationRedeemed ? (
          <div className="mt-5 rounded-xl border border-cyan/25 bg-cyan/[0.07] px-4 py-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-cyan/15 text-cyan">
                <Check className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-cyan">授权已生效</p>
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">当前账号永久有效。</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <label htmlFor="invitation-code" className="font-medium">邀请码</label>
                <button
                  type="button"
                  onClick={() => void copySupport()}
                  className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-amber focus-visible:outline-none focus-visible:text-amber"
                  aria-label="复制客服 QQ"
                >
                  {copied ? "已复制 QQ" : <>联系 QQ <span className="font-semibold text-amber">{SUPPORT_QQ}</span> 申请</>}
                </button>
              </div>
              <span className="mt-2 flex h-10 items-center gap-2 rounded-lg border border-white/12 bg-black/20 px-3 transition duration-150 hover:border-cyan/30 focus-within:border-cyan/65 focus-within:bg-cyan/[0.035] focus-within:ring-2 focus-within:ring-cyan/15">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                <input
                  id="invitation-code"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.toUpperCase());
                    setError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void redeem();
                  }}
                  placeholder="ECHO-XXXX-XXXX-XXXX"
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm tracking-wide outline-none placeholder:text-muted-foreground"
                />
              </span>
            </div>

            <div className="mt-4 flex min-h-9 items-center justify-between gap-3">
              <p className="text-xs text-rose-300" role="alert">{error}</p>
              <button
                type="button"
                onClick={() => void redeem()}
                disabled={!code.trim() || isSubmitting}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-cyan/65 bg-cyan px-4 text-sm font-semibold text-black shadow-lg shadow-cyan/15 transition duration-150 hover:-translate-y-0.5 hover:bg-[#67e8f9] hover:shadow-cyan/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:translate-y-0 disabled:border-transparent disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
              >
                {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
                确认
              </button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}