"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, Info, Minus, Plus } from "lucide-react";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_FILTER_DRAFT, type VideoFilterDraft } from "@/lib/batch/video-filters";

const inputClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const labelClass = "grid min-w-0 gap-1 text-xs text-muted-foreground";
const popupClass = "z-50 rounded-md border border-border bg-surface-strong shadow-xl shadow-black/30 focus-visible:outline-2 focus-visible:outline-ring";
const stepClass = "flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground transition hover:bg-muted hover:text-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30";

export function VideoFilterFields({ value, disabled, platform, onChange }: {
  value: VideoFilterDraft;
  disabled: boolean;
  platform: "douyin" | "bilibili";
  onChange: (value: VideoFilterDraft) => void;
}) {
  const update = (patch: Partial<VideoFilterDraft>) => onChange({ ...value, ...patch });
  const count = Number(value.limit);
  const canStep = /^\d+$/u.test(value.limit.trim()) && Number.isInteger(count);
  const step = (delta: number) => update({ limit: String(Math.min(5000, Math.max(1, count + delta))) });
  return (
    <fieldset aria-label="获取范围" className="mt-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">获取范围</span>
          <Popover.Root>
            <Popover.Trigger asChild>
              <button type="button" aria-label="获取范围说明" className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><Info className="size-3.5" aria-hidden="true" /></button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="start" sideOffset={6} className={`${popupClass} w-72 max-w-[calc(100vw-2rem)] p-3`}>
                <ul className="list-disc space-y-1.5 pl-4 text-xs leading-5 text-muted-foreground">
                  <li>日期包含首尾当天（北京时间）。</li>
                  <li>先筛选，再取最新或最早的 N 个。</li>
                  <li>留空默认获取全部视频。</li>
                  <li>仅获取账号可见的公开视频。</li>
                  <li>抖音需要有效访问凭据。</li>
                  <li>Bilibili 多分 P 作品会转录全部分 P。</li>
                  {platform === "bilibili" && value.tags.trim() && <li>标签筛选会额外查询作品标签。</li>}
                </ul>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
        <button type="button" disabled={disabled} onClick={() => onChange(DEFAULT_FILTER_DRAFT)} className="text-xs text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">重置筛选</button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
        <div className={`${labelClass} sm:w-32`}>
          <label htmlFor="video-range-mode">作品范围</label>
          <Select value={value.mode} disabled={disabled} onValueChange={(mode: VideoFilterDraft["mode"]) => update({ mode })}>
            <SelectTrigger id="video-range-mode" className={`${inputClass} justify-between`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部作品</SelectItem><SelectItem value="newest">最新 N 个</SelectItem><SelectItem value="oldest">最早 N 个</SelectItem></SelectContent>
          </Select>
        </div>
        {value.mode !== "all" && (
          <div className={`${labelClass} sm:w-24`}>
            <label htmlFor="video-count">作品数量</label>
            <div className="flex h-8 overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
              <button type="button" aria-label="减少作品数量" disabled={disabled || !canStep || count <= 1} onClick={() => step(-1)} className={`${stepClass} border-r border-input`}><Minus className="size-3" aria-hidden="true" /></button>
              <input id="video-count" role="spinbutton" inputMode="numeric" aria-valuemin={1} aria-valuemax={5000} aria-valuenow={canStep ? count : undefined} disabled={disabled} value={value.limit} onChange={(event) => update({ limit: event.target.value })} onKeyDown={(event) => {
                if (canStep && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  step(event.key === "ArrowUp" ? 1 : -1);
                }
              }} className="h-full w-full min-w-0 bg-transparent text-center text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50" />
              <button type="button" aria-label="增加作品数量" disabled={disabled || !canStep || count >= 5000} onClick={() => step(1)} className={`${stepClass} border-l border-input`}><Plus className="size-3" aria-hidden="true" /></button>
            </div>
          </div>
        )}
        <div className="col-span-2 flex gap-2">
          <DateFilter label="开始日期" value={value.publishedFrom} disabled={disabled} onChange={(publishedFrom) => update({ publishedFrom })} />
          <DateFilter label="结束日期" value={value.publishedTo} disabled={disabled} onChange={(publishedTo) => update({ publishedTo })} />
        </div>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
        <label className={`${labelClass} sm:w-48`}>标题关键词<input disabled={disabled} value={value.keyword} maxLength={200} placeholder="可选，匹配标题文字" onChange={(event) => update({ keyword: event.target.value })} className={inputClass} /></label>
        <div className="flex items-end gap-2">
          <label className={`${labelClass} flex-1 sm:w-52 sm:flex-none`}>视频标签<input disabled={disabled} value={value.tags} placeholder="#摄影 #旅行，或用逗号分隔" onChange={(event) => update({ tags: event.target.value })} className={inputClass} /></label>
          <Select value={value.tagMode} disabled={disabled} onValueChange={(tagMode: VideoFilterDraft["tagMode"]) => update({ tagMode })}>
            <SelectTrigger aria-label="标签匹配方式" className={`${inputClass} w-28 shrink-0 justify-between`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="any">任一标签</SelectItem><SelectItem value="all">全部标签</SelectItem></SelectContent>
          </Select>
        </div>
      </div>
    </fieldset>
  );
}

function DateFilter({ label, value, disabled, onChange }: {
  label: string; value: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? new Date(`${value}T00:00:00`) : undefined;
  return (
    <div className={`${labelClass} min-w-0 flex-1 sm:w-36 sm:flex-none`}>
      <span>{label}</span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={label} disabled={disabled} className={`${inputClass} flex items-center justify-between gap-2 text-left`}>
            <span className={value ? "text-foreground" : "text-muted-foreground"}>{value || "不限日期"}</span>
            <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={6} className={`${popupClass} w-[17.5rem] max-w-[calc(100vw-1rem)]`}>
            <Calendar mode="single" selected={selected} defaultMonth={selected} locale={zhCN} captionLayout="dropdown" onSelect={(date) => {
              onChange(date ? format(date, "yyyy-MM-dd") : "");
              setOpen(false);
            }} classNames={{
              day_button: "inline-flex size-9 items-center justify-center rounded-md text-sm transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected: "[&>button]:!bg-primary [&>button]:!text-primary-foreground",
              today: "[&>button]:font-semibold [&>button]:text-primary",
              chevron: "size-4 stroke-muted-foreground group-hover:stroke-primary",
            }} />
            <div className="border-t border-border px-3 py-2"><button type="button" onClick={() => { onChange(""); setOpen(false); }} className="text-xs text-muted-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">清除{label}</button></div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
