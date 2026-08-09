"use client";

import { Loader2, Send, X } from "lucide-react";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type FeedbackType = "bug" | "feature" | "other";

export function FeedbackDialog({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [type, setType] = useState<FeedbackType>();
  const trimmedContent = content.trim();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedContent || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/feedback", {
        body: JSON.stringify({ content: trimmedContent, type: type ?? null }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "反馈提交失败，请稍后重试。");
      }
      onSubmitted();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "反馈提交失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
      <form
        onSubmit={submit}
        className="flex w-full max-w-xl flex-col gap-5 rounded-xl border border-white/15 bg-background p-5 shadow-2xl shadow-black/50 sm:p-6"
        aria-label="提交反馈"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">反馈</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="关闭反馈"
            title="关闭"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="relative">
          <textarea
            autoFocus
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={4000}
            rows={7}
            placeholder="告诉我们你的问题、建议或使用体验"
            className="min-h-40 w-full resize-y rounded-lg border border-white/12 bg-black/20 px-3 py-2.5 pb-8 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:border-cyan/55 focus:ring-2 focus:ring-cyan/15"
          />
          <span className="pointer-events-none absolute bottom-2.5 right-3 text-xs tabular-nums text-muted-foreground">
            {content.length}/4000
          </span>
        </div>

        <div className="grid gap-1.5 text-sm font-medium text-foreground">
          <div className="flex items-center gap-1.5">
            <span>反馈类型</span>
            <span className="font-normal text-muted-foreground">（可选）</span>
          </div>
          <Select value={type} onValueChange={(value) => setType(value as FeedbackType)}>
            <SelectTrigger className="h-10 w-full justify-between border-white/12 bg-black/20 px-3 text-sm hover:bg-black/30 focus-visible:border-cyan/55 focus-visible:ring-2 focus-visible:ring-cyan/15">
              <SelectValue placeholder="请选择反馈类型" />
            </SelectTrigger>
            <SelectContent className="z-[80] border-white/12 bg-[#141821] text-foreground">
              <SelectItem value="bug">问题反馈</SelectItem>
              <SelectItem value="feature">功能建议</SelectItem>
              <SelectItem value="other">其他</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!trimmedContent || submitting}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-cyan px-4 text-sm font-semibold text-black transition hover:bg-[#67e8f9] disabled:cursor-not-allowed disabled:bg-white/15 disabled:text-muted-foreground"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
            发送反馈
          </button>
        </div>
      </form>
    </div>
  );
}