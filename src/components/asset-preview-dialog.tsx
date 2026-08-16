"use client";

import Image from "next/image";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  Pause,
  Play,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import type { MediaAssetKind } from "@/types/douyin";
import { cn } from "@/lib/utils";

export type AssetPreviewAction = {
  asset: MediaAssetKind;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  previewLabel: string;
};

export function AssetPreviewDialog({
  action,
  downloadUrl,
  onClose,
  onDownload,
  onResourceError,
  previewUrl,
}: {
  action: AssetPreviewAction;
  downloadUrl: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
  onResourceError: () => void;
  previewUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  async function copyCover() {
    const absoluteDownloadUrl = new URL(downloadUrl, window.location.origin).toString();
    try {
      const response = await fetch(previewUrl);
      const blob = await response.blob();
      if (blob.type.startsWith("image/") && "ClipboardItem" in window) {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } else {
        await navigator.clipboard.writeText(absoluteDownloadUrl);
      }
    } catch {
      await navigator.clipboard.writeText(absoluteDownloadUrl);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-end justify-center overflow-hidden bg-[#020409] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:items-center sm:px-4 sm:py-6"
      role="dialog"
      aria-modal="true"
      aria-label={action.previewLabel}
    >
      <div className="max-h-[calc(100dvh_-_1.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] w-full max-w-3xl overflow-hidden rounded-lg border border-white/20 bg-background shadow-2xl shadow-black/40 sm:max-h-[calc(100dvh_-_3rem)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 font-semibold">
            <action.icon className="size-4 shrink-0 text-cyan" aria-hidden />
            <span className="truncate">{action.previewLabel}</span>
          </div>
          <div className="flex items-center gap-1">
            {action.asset === "cover" ? (
              <button
                type="button"
                onClick={() => void copyCover()}
                className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
                aria-label={copied ? "已复制封面" : "复制封面"}
                title={copied ? "已复制" : "复制封面"}
              >
                {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setDownloadError("");
                void onDownload().catch((error) => {
                  setDownloadError(error instanceof Error ? error.message : "文件保存失败。");
                });
              }}
              className="inline-flex size-8 items-center justify-center rounded-md text-cyan transition hover:bg-cyan/[0.08] hover:text-amber"
              aria-label={action.label}
              title={downloadError || action.label}
            >
              <Download className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
              aria-label="关闭预览"
              title="关闭"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
        {downloadError ? (
          <p className="border-b border-white/10 px-4 py-2 text-xs font-medium text-rose-400" role="alert">
            {downloadError}
          </p>
        ) : null}
        <div className="max-h-[calc(100dvh_-_5.5rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] overflow-auto bg-black/25 p-3 sm:max-h-[calc(100dvh_-_7rem)] sm:p-4">
          <AssetPreviewContent asset={action.asset} url={previewUrl} onResourceError={onResourceError} />
        </div>
      </div>
    </div>
  );
}

function AssetPreviewContent({
  asset,
  onResourceError,
  url,
}: {
  asset: MediaAssetKind;
  onResourceError: () => void;
  url: string;
}) {
  if (asset === "cover") return <CoverPreview key={url} url={url} onResourceError={onResourceError} />;
  if (asset === "video") return <VideoPreview key={url} url={url} onResourceError={onResourceError} />;
  return <AudioPreview key={url} url={url} onResourceError={onResourceError} />;
}

function CoverPreview({ onResourceError, url }: { onResourceError: () => void; url: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative mx-auto max-w-2xl overflow-hidden rounded-md bg-black/40">
      <LoadingOverlay visible={!loaded} label="资源加载中" />
      <Image
        src={url}
        alt="封面预览"
        width={1200}
        height={675}
        unoptimized
        onLoad={() => setLoaded(true)}
        onError={onResourceError}
        className={cn("h-auto max-h-[68dvh] w-full object-contain transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}

function VideoPreview({ onResourceError, url }: { onResourceError: () => void; url: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-md bg-black/40">
      <LoadingOverlay visible={!loaded} label="视频加载中" />
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        onLoadedMetadata={() => setLoaded(true)}
        onCanPlay={() => setLoaded(true)}
        onError={onResourceError}
        className={cn("max-h-[68dvh] w-full rounded-md bg-black transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}

function AudioPreview({ onResourceError, url }: { onResourceError: () => void; url: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [gain, setGain] = useState(1);

  function syncMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    setError(null);
    setLoaded(true);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setError("音频播放失败，请重新打开预览后再试。");
      }
    } else {
      audio.pause();
    }
  }

  function seek(value: string) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const nextTime = Number(value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function changeGain(value: string) {
    const audio = audioRef.current;
    const nextGain = Math.min(1, Math.max(0, Number(value)));
    setGain(nextGain);
    if (!audio) return;
    audio.volume = nextGain;
    audio.muted = nextGain === 0;
  }

  return (
    <div className="relative rounded-md bg-[linear-gradient(180deg,rgb(255_255_255_/_0.045),rgb(255_255_255_/_0.018))] p-3 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)] sm:p-4">
      {error ? <ErrorOverlay label={error} /> : <LoadingOverlay visible={!loaded} label="音频加载中" />}
      <audio
        ref={audioRef}
        crossOrigin="anonymous"
        src={url}
        preload="metadata"
        onLoadedMetadata={syncMetadata}
        onCanPlay={syncMetadata}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onVolumeChange={() => {
          if (audioRef.current?.muted) setGain(0);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setLoaded(false);
          setError("音频资源加载失败。");
          onResourceError();
        }}
      />
      <div className={cn("grid min-h-14 gap-3 transition-opacity duration-200 md:grid-cols-[minmax(0,1fr)_12rem] md:items-center", loaded && !error ? "opacity-100" : "opacity-0")}>
        <div className="grid min-w-0 grid-cols-[auto_auto_minmax(8rem,1fr)_auto] items-center gap-2">
          <button
            type="button"
            onClick={() => void togglePlayback()}
            disabled={!loaded || Boolean(error)}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-cyan/10 text-cyan transition hover:bg-cyan/15 hover:text-amber active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={playing ? "暂停音频" : "播放音频"}
            title={playing ? "暂停" : "播放"}
          >
            {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
          </button>
          <span className="shrink-0 text-sm font-medium tabular-nums text-foreground/90">{formatMediaTime(currentTime)}</span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.01"
            value={duration ? Math.min(currentTime, duration) : 0}
            onChange={(event) => seek(event.currentTarget.value)}
            disabled={!loaded || !duration}
            className="audio-progress h-2 min-w-0 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="音频播放进度"
          />
          <span className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">{formatMediaTime(duration)}</span>
        </div>
        <div className="grid min-w-0 grid-cols-[auto_minmax(5rem,1fr)_2.5rem] items-center gap-2 md:min-w-48">
          <Volume2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={gain}
            onChange={(event) => changeGain(event.currentTarget.value)}
            disabled={!loaded || Boolean(error)}
            className="audio-progress h-2 min-w-0 cursor-pointer appearance-none rounded-full bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="音频音量"
          />
          <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">{Math.round(gain * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

function LoadingOverlay({ label, visible }: { label: string; visible: boolean }) {
  return visible ? (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 backdrop-blur-[2px]">
      <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-cyan" aria-hidden />
        {label}
      </div>
    </div>
  ) : null;
}

function ErrorOverlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/45 backdrop-blur-[2px]">
      <div className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
        <AlertCircle className="size-4 text-amber" aria-hidden />
        {label}
      </div>
    </div>
  );
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}