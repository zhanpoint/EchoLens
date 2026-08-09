"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays,
  ArrowLeft,
  Bot,
  BrainCircuit,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FolderOpen,
  KeyRound,
  Loader2,
  Maximize2,
  MonitorDown,
  Pencil,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  TestTube2,
  Trash2,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import {
  Calendar,
} from "@/components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  detectDesktopPlatform,
  detectWindowsArchitecture,
  type SupportedDesktopPlatform,
  type WindowsArchitecture,
} from "@/lib/client-platform";
import credentialHelperArtifacts from "@/lib/douyin/credential-helper-artifacts.json";
import {
  cacheDownloadOrganization,
  chooseDownloadDirectory,
  supportsDownloadDirectoryPicker,
} from "@/lib/browser-download-directory";
import {
  DEFAULT_BILIBILI_AUDIO_QUALITY,
  DEFAULT_BILIBILI_VIDEO_CODEC,
  DEFAULT_BILIBILI_VIDEO_QUALITY,
  DEFAULT_DOWNLOAD_ORGANIZATION,
  DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  isBilibiliAudioQuality,
  isBilibiliVideoCodec,
  isBilibiliVideoQuality,
  isDownloadOrganization,
  isDownloadVideoQuality,
  type BilibiliAudioQuality,
  type BilibiliVideoCodec,
  type BilibiliVideoQuality,
  type DownloadOrganization,
  type DownloadVideoQuality,
} from "@/lib/download-settings";
import { getApiError, readJsonPayload, readUserFacingError } from "../douyin/_client-api";
import {
  DASHSCOPE_FIXED_BASE_URL,
} from "@/lib/dashscope/fixed-config";
import {
  DASHSCOPE_MODEL_METADATA,
  DASHSCOPE_MODEL_OPTIONS,
  DEFAULT_DASHSCOPE_MODELS,
  normalizeDashScopeModelIds,
  type DashScopeModelPurpose,
  type EchoLensDashScopeModelIds,
} from "@/lib/dashscope/model-config";

type DouyinSettings = {
  credentialStatus?: "invalid" | "missing" | "unknown" | "valid";
  cookie: string;
};
type BilibiliSettings = {
  credentialStatus?: "invalid" | "missing" | "valid";
  cookie: string;
};

type UserSettingsPayload = {
  settings?: {
    aiCredential?: { configured?: boolean };
    aiModels?: Partial<EchoLensDashScopeModelIds>;
    bilibili?: Partial<BilibiliSettings>;
    douyin?: Partial<DouyinSettings>;
    download?: Partial<DownloadSettings>;
  };
};

type ApiAccessTokenRecord = {
  createdAt: number;
  expiresAt?: number;
  id: string;
  isExpired: boolean;
  lastUsedAt?: number;
  name: string;
  prefix: string;
  updatedAt: number;
};

type ApiAccessTokensPayload = {
  record?: ApiAccessTokenRecord;
  token?: string;
  tokens?: ApiAccessTokenRecord[];
};

type AiCredentialPayload = {
  apiKey?: string;
};

type SettingsSection = "aiCredential" | "apiTokens" | "douyin" | "download";
type CredentialMethod = "automatic" | "manual";

type DownloadSettings = {
  bilibiliAudioQuality: BilibiliAudioQuality;
  bilibiliVideoCodec: BilibiliVideoCodec;
  bilibiliVideoQuality: BilibiliVideoQuality;
  directoryPath: string;
  organization: DownloadOrganization;
  videoQuality: DownloadVideoQuality;
};

type CredentialStatus = "idle" | "valid" | "invalid" | "unavailable";

type BilibiliQrSession = {
  qrcodeKey: string;
  svg: string;
};

type BilibiliQrPollPayload = {
  message?: string;
  state?: Partial<BilibiliSettings>;
  status?: "confirmed" | "expired" | "pending" | "scanned";
};

type PlatformIconProps = {
  className?: string;
};

function DouyinIcon({ className }: PlatformIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M14 4v9.5a4.5 4.5 0 1 1-4.5-4.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M14 4c1.1 2.9 3.1 4.8 6 5.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M14 7.2c1.1 1.6 2.6 2.6 4.6 3"
        stroke="#22D3EE"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function BilibiliIcon({ className }: PlatformIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="m8 5-2-2M16 5l2-2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <rect
        x="4"
        y="6"
        width="16"
        height="13"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M9 12.5v1M15 12.5v1M10 16h4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function PlatformCredentialHeading({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="inline-flex size-7 shrink-0 items-center justify-center text-cyan">
        {icon}
      </span>
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
    </div>
  );
}

type Feedback = {
  message: string;
  tone: "success" | "warning" | "error";
};

function FeedbackMessage({
  feedback,
  feedbackRef,
}: {
  feedback?: Feedback;
  feedbackRef: Ref<HTMLParagraphElement>;
}) {
  if (!feedback) return null;

  return (
    <p
      ref={feedbackRef}
      className={`mt-2 text-xs font-medium leading-5 ${
        feedback.tone === "success"
          ? "text-emerald-400"
          : feedback.tone === "error"
            ? "text-rose-400"
            : "text-amber"
      }`}
      role={feedback.tone === "error" ? "alert" : "status"}
      aria-live={feedback.tone === "error" ? "assertive" : "polite"}
    >
      {feedback.message}
    </p>
  );
}

type CredentialModelTest =
  | { id: string; ok: true; purpose: DashScopeModelPurpose }
  | { detail: string; id: string; ok: false; purpose: DashScopeModelPurpose };

function normalizeDouyinSettings(value: Partial<DouyinSettings> | undefined): DouyinSettings {
  return {
    credentialStatus: value?.credentialStatus,
    cookie: typeof value?.cookie === "string" ? value.cookie : "",
  };
}

function normalizeBilibiliSettings(value: Partial<BilibiliSettings> | undefined): BilibiliSettings {
  return {
    credentialStatus: value?.credentialStatus,
    cookie: typeof value?.cookie === "string" ? value.cookie : "",
  };
}

function normalizeDownloadSettings(value: Partial<DownloadSettings> | undefined): DownloadSettings {
  const organization = value?.organization;
  return {
    bilibiliAudioQuality: isBilibiliAudioQuality(value?.bilibiliAudioQuality)
      ? value.bilibiliAudioQuality
      : DEFAULT_BILIBILI_AUDIO_QUALITY,
    bilibiliVideoCodec: isBilibiliVideoCodec(value?.bilibiliVideoCodec)
      ? value.bilibiliVideoCodec
      : DEFAULT_BILIBILI_VIDEO_CODEC,
    bilibiliVideoQuality: isBilibiliVideoQuality(value?.bilibiliVideoQuality)
      ? value.bilibiliVideoQuality
      : isDownloadVideoQuality(value?.videoQuality)
        ? value.videoQuality
        : DEFAULT_BILIBILI_VIDEO_QUALITY,
    directoryPath: typeof value?.directoryPath === "string" ? value.directoryPath : "",
    organization: isDownloadOrganization(organization) ? organization : DEFAULT_DOWNLOAD_ORGANIZATION,
    videoQuality: isDownloadVideoQuality(value?.videoQuality)
      ? value.videoQuality
      : DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  };
}

function detectSupportedPlatform(): SupportedDesktopPlatform | null {
  const clientNavigator = navigator as Navigator & { userAgentData?: ClientUserAgentData };
  return detectDesktopPlatform({
    platform: clientNavigator.userAgentData?.platform || navigator.platform,
    userAgent: navigator.userAgent,
  });
}

type ClientUserAgentData = {
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
  }>;
  platform?: string;
};

function subscribeToPlatform(): () => void {
  return () => undefined;
}

const DOWNLOAD_ORGANIZATION_OPTIONS: Array<{
  description: string;
  example: string;
  label: string;
  value: DownloadOrganization;
}> = [
  { value: "work", label: "按作品", description: "每个作品独立建目录，封面、视频和原声集中存放。", example: "作品标题/视频.mp4" },
  { value: "author", label: "按作者", description: "每位作者独立建目录，该作者的所有作品集中存放。", example: "作者名称/作品视频.mp4" },
  { value: "fileType", label: "按文件类型", description: "按视频、音频、图片和文本类型分别归档。", example: "视频/作品视频.mp4" },
  { value: "date", label: "按日期", description: "按下载当天的本地日期创建目录。", example: "2026-07-14/作品视频.mp4" },
  { value: "flat", label: "完全扁平化", description: "不创建任何子目录，全部文件直接放在下载目录。", example: "作品视频.mp4" },
];

const DOWNLOAD_VIDEO_QUALITY_OPTIONS: Array<{
  description: string;
  label: string;
  value: DownloadVideoQuality;
}> = [
  { value: "lowest", label: "最低画质（默认）", description: "选择接口返回的最低码率视频源，节省下载时间和存储空间。" },
  { value: "360p", label: "360P", description: "选择最接近 640×360 的可用视频源。" },
  { value: "480p", label: "480P", description: "选择最接近 854×480 的可用视频源。" },
  { value: "540p", label: "540P", description: "选择最接近 960×540 的可用视频源。" },
  { value: "720p", label: "720P", description: "选择最接近 1280×720 的可用视频源。" },
  { value: "1080p", label: "1080P", description: "选择最接近 1920×1080 的可用视频源。" },
  { value: "1440p", label: "1440P", description: "选择最接近 2560×1440 的可用视频源。" },
  { value: "highest", label: "最高画质", description: "选择接口返回的最高码率视频源。" },
];

const BILIBILI_VIDEO_QUALITY_OPTIONS: Array<{
  description: string;
  label: string;
  value: BilibiliVideoQuality;
}> = [
  { value: "lowest", label: "省流模式（默认）", description: "文件更小，适合只听内容或节省空间。" },
  { value: "360p", label: "360P", description: "基础清晰度，文件较小。" },
  { value: "480p", label: "480P", description: "日常观看清晰度。" },
  { value: "540p", label: "540P", description: "比 480P 更清晰。" },
  { value: "720p", label: "720P 高清", description: "清晰度与文件大小较均衡。" },
  { value: "1080p", label: "1080P 全高清", description: "画面更清晰，文件更大。" },
  { value: "1440p", label: "2K（1440P）", description: "需要视频和账号支持。" },
  { value: "2160p", label: "4K（2160P）", description: "文件较大，需要视频和账号支持。" },
  { value: "4320p", label: "8K（4320P）", description: "文件很大，仅少量视频支持。" },
  { value: "highest", label: "最高可用清晰度", description: "自动选择当前可用的最清晰版本。" },
];

const BILIBILI_AUDIO_QUALITY_OPTIONS: Array<{
  description: string;
  label: string;
  value: BilibiliAudioQuality;
}> = [
  { value: "lowest", label: "省流音质（默认）", description: "文件更小，适合只听内容。" },
  { value: "64k", label: "标准音质（64K）", description: "适合普通语音和背景音乐。" },
  { value: "132k", label: "较清晰音质（132K）", description: "人声和音乐细节更清楚。" },
  { value: "192k", label: "高音质（192K）", description: "适合重视音乐细节的内容。" },
  { value: "hiRes", label: "Hi-Res 无损", description: "音质最好，文件会更大。" },
  { value: "dolby", label: "杜比音效", description: "需要视频和播放设备支持。" },
  { value: "highest", label: "最高可用音质", description: "自动选择当前可用的最佳音质。" },
];

const BILIBILI_VIDEO_CODEC_OPTIONS: Array<{
  description: string;
  label: string;
  value: BilibiliVideoCodec;
}> = [
  { value: "avc", label: "兼容模式（H.264 / AVC，默认）", description: "大多数设备都能正常播放。" },
  { value: "hevc", label: "省空间模式（H.265 / HEVC）", description: "文件更小，旧设备可能无法播放。" },
  { value: "av1", label: "高效压缩模式（AV1）", description: "文件更小，需要较新的设备或播放器。" },
];

function DownloadSettingsPanel({
  isLoaded,
  onSettingsChange,
  settings,
}: {
  isLoaded: boolean;
  onSettingsChange: (settings: DownloadSettings) => void;
  settings: DownloadSettings;
}) {
  const [feedback, setFeedback] = useState<Feedback>();
  const [downloadPlatform, setDownloadPlatform] = useState<"douyin" | "bilibili">("douyin");
  const [isSaving, setIsSaving] = useState(false);
  const helpDetailsRef = useRef<HTMLDetailsElement>(null);
  const directoryPickerSupported = supportsDownloadDirectoryPicker();
  const selectedOrganization = DOWNLOAD_ORGANIZATION_OPTIONS.find((option) => option.value === settings.organization)
    ?? DOWNLOAD_ORGANIZATION_OPTIONS[0];
  const selectedVideoQuality = DOWNLOAD_VIDEO_QUALITY_OPTIONS.find((option) => option.value === settings.videoQuality)
    ?? DOWNLOAD_VIDEO_QUALITY_OPTIONS[0];
  const selectedBilibiliVideoQuality = BILIBILI_VIDEO_QUALITY_OPTIONS.find((option) => option.value === settings.bilibiliVideoQuality)
    ?? BILIBILI_VIDEO_QUALITY_OPTIONS[0];
  const selectedBilibiliAudioQuality = BILIBILI_AUDIO_QUALITY_OPTIONS.find((option) => option.value === settings.bilibiliAudioQuality)
    ?? BILIBILI_AUDIO_QUALITY_OPTIONS[0];
  const selectedBilibiliCodec = BILIBILI_VIDEO_CODEC_OPTIONS.find((option) => option.value === settings.bilibiliVideoCodec)
    ?? BILIBILI_VIDEO_CODEC_OPTIONS[0];

  useEffect(() => {
    function closeHelpOnOutsidePointer(event: PointerEvent) {
      const details = helpDetailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
      }
    }

    document.addEventListener("pointerdown", closeHelpOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeHelpOnOutsidePointer);
  }, []);

  async function chooseDirectory() {
    setFeedback(undefined);
    try {
      const handle = await chooseDownloadDirectory();
      await persistDownloadSettings({ ...settings, directoryPath: handle.name });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFeedback({ message: readUserFacingError(error, "无法选择下载目录。"), tone: "error" });
    }
  }

  async function persistDownloadSettings(nextSettings: DownloadSettings) {
    const previousSettings = settings;
    onSettingsChange(nextSettings);
    cacheDownloadOrganization(nextSettings.organization);
    setIsSaving(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "download", value: nextSettings }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "下载配置保存失败。") as UserSettingsPayload;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "下载配置保存失败。");
      }
      const savedSettings = normalizeDownloadSettings(payload.settings?.download);
      onSettingsChange(savedSettings);
      cacheDownloadOrganization(savedSettings.organization);
      setFeedback(undefined);
    } catch (error) {
      onSettingsChange(previousSettings);
      cacheDownloadOrganization(previousSettings.organization);
      setFeedback({ message: readUserFacingError(error, "下载配置保存失败。"), tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-4 flex items-center gap-1.5">
        <h2 className="text-base font-semibold text-foreground">下载配置</h2>
        <details ref={helpDetailsRef} className="relative">
          <summary
            className="inline-flex size-6 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30 [&::-webkit-details-marker]:hidden"
            aria-label="查看下载目录说明"
            title="下载目录说明"
          >
            <CircleHelp className="size-4" aria-hidden="true" />
          </summary>
          <div className="absolute left-0 top-7 z-20 w-[min(22rem,calc(100vw-3rem))] rounded-md border border-white/15 bg-surface-strong p-3 text-xs font-normal leading-5 text-muted-foreground shadow-xl shadow-black/30">
            Chrome 和 Edge 支持选择自定义目录，其他浏览器将使用浏览器默认下载目录。受浏览器安全限制，网页只能读取已授权目录的名称，无法获取完整磁盘路径。
          </div>
        </details>
      </div>

      <div
        className="mb-4 grid grid-cols-2 rounded-md bg-white/[0.045] p-0.5"
        role="group"
        aria-label="下载配置平台"
      >
        <button
          type="button"
          aria-pressed={downloadPlatform === "douyin"}
          onClick={() => setDownloadPlatform("douyin")}
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
            downloadPlatform === "douyin"
              ? "bg-surface-strong text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <DouyinIcon className="size-4 text-cyan" />
          抖音下载配置
        </button>
        <button
          type="button"
          aria-pressed={downloadPlatform === "bilibili"}
          onClick={() => setDownloadPlatform("bilibili")}
          className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
            downloadPlatform === "bilibili"
              ? "bg-surface-strong text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <BilibiliIcon className="size-4 text-cyan" />
          Bilibili 下载配置
        </button>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_10.5rem_auto]">
        <label className="whitespace-nowrap text-xs font-semibold text-foreground" htmlFor="download-directory-path">
          默认下载目录：
        </label>
        <input
          id="download-directory-path"
          value={settings.directoryPath}
          readOnly
          placeholder="浏览器默认下载目录"
          className="h-11 min-w-0 rounded-md border border-white/10 bg-black/25 px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground/65 focus:border-cyan/60 focus:ring-2 focus:ring-cyan/15"
        />
        <div className="col-span-2 grid grid-cols-[minmax(0,10.5rem)_auto] items-center gap-2 sm:col-span-1 sm:contents">
          <Select
            value={settings.organization}
            onValueChange={(value) => {
              if (!isDownloadOrganization(value)) return;
              void persistDownloadSettings({ ...settings, organization: value });
            }}
            disabled={!isLoaded || isSaving}
          >
            <SelectTrigger
              aria-label="目录组织方式"
              className="h-11 w-full min-w-0 justify-between border-0 bg-white/[0.045] px-3 hover:bg-white/[0.075] focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="shrink-0 text-foreground">目录组织方式</span>
                <span className="ml-auto truncate text-xs font-semibold text-foreground">{selectedOrganization.label}</span>
              </span>
            </SelectTrigger>
            <SelectContent
              align="end"
              sideOffset={6}
              className="w-[min(24rem,calc(100vw-2rem))] border-white/10 bg-surface-strong p-1"
            >
              {DOWNLOAD_ORGANIZATION_OPTIONS.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  textValue={option.label}
                  className="items-start py-2 pl-9 pr-3 focus:bg-cyan/[0.1]"
                >
                  <span className="grid gap-1 text-left">
                    <span className="text-xs font-semibold text-foreground">{option.label}</span>
                    <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                    <code className="text-[11px] text-cyan/85">示例：{option.example}</code>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => void chooseDirectory()}
            disabled={!directoryPickerSupported || !isLoaded || isSaving}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-md border-0 bg-white/[0.045] px-3 text-xs font-semibold text-cyan transition hover:bg-white/[0.075] active:scale-[0.98] disabled:cursor-not-allowed disabled:text-muted-foreground"
          >
            {isSaving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <FolderOpen className="size-3.5" aria-hidden="true" />}
            {settings.directoryPath ? "更换目录" : "选择目录"}
          </button>
        </div>
      </div>

      {downloadPlatform === "douyin" ? (
        <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:max-w-md">
        <span className="whitespace-nowrap text-xs font-semibold text-foreground">抖音视频清晰度：</span>
        <Select
          value={settings.videoQuality}
          onValueChange={(value) => {
            if (!isDownloadVideoQuality(value)) return;
            void persistDownloadSettings({ ...settings, videoQuality: value });
          }}
          disabled={!isLoaded || isSaving}
        >
          <SelectTrigger
            aria-label="抖音视频清晰度"
            className="h-11 w-full min-w-0 justify-between border-0 bg-white/[0.045] px-3 hover:bg-white/[0.075] focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="truncate text-xs font-semibold text-foreground">{selectedVideoQuality.label}</span>
          </SelectTrigger>
          <SelectContent align="start" sideOffset={6} className="w-[min(25rem,calc(100vw-2rem))] border-white/10 bg-surface-strong p-1">
            {DOWNLOAD_VIDEO_QUALITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} textValue={option.label} className="items-start py-2 pl-9 pr-3 focus:bg-cyan/[0.1]">
                <span className="grid gap-1 text-left">
                  <span className="text-xs font-semibold text-foreground">{option.label}</span>
                  <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>
      ) : null}

      {downloadPlatform === "bilibili" ? (
        <div className="mt-3">
          <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-1.5">
            <span className="text-xs font-semibold text-foreground">视频清晰度</span>
            <Select
              value={settings.bilibiliVideoQuality}
              onValueChange={(value) => {
                if (!isBilibiliVideoQuality(value)) return;
                void persistDownloadSettings({ ...settings, bilibiliVideoQuality: value });
              }}
              disabled={!isLoaded || isSaving}
            >
              <SelectTrigger
                aria-label="Bilibili 视频清晰度"
                className="h-11 w-full min-w-0 justify-between border-0 bg-white/[0.045] px-3 hover:bg-white/[0.075] focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="truncate text-xs font-semibold text-foreground">{selectedBilibiliVideoQuality.label}</span>
              </SelectTrigger>
              <SelectContent align="start" sideOffset={6} className="w-[min(26rem,calc(100vw-2rem))] border-white/10 bg-surface-strong p-1">
                {BILIBILI_VIDEO_QUALITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} textValue={option.label} className="items-start py-2 pl-9 pr-3 focus:bg-cyan/[0.1]">
                    <span className="grid gap-1 text-left">
                      <span className="text-xs font-semibold text-foreground">{option.label}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-semibold text-foreground">文件兼容性</span>
            <Select
              value={settings.bilibiliVideoCodec}
              onValueChange={(value) => {
                if (!isBilibiliVideoCodec(value)) return;
                void persistDownloadSettings({ ...settings, bilibiliVideoCodec: value });
              }}
              disabled={!isLoaded || isSaving}
            >
              <SelectTrigger
                aria-label="Bilibili 文件兼容性"
                className="h-11 w-full min-w-0 justify-between border-0 bg-white/[0.045] px-3 hover:bg-white/[0.075] focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="truncate text-xs font-semibold text-foreground">{selectedBilibiliCodec.label}</span>
              </SelectTrigger>
              <SelectContent align="start" sideOffset={6} className="w-[min(26rem,calc(100vw-2rem))] border-white/10 bg-surface-strong p-1">
                {BILIBILI_VIDEO_CODEC_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} textValue={option.label} className="items-start py-2 pl-9 pr-3 focus:bg-cyan/[0.1]">
                    <span className="grid gap-1 text-left">
                      <span className="text-xs font-semibold text-foreground">{option.label}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <span className="text-xs font-semibold text-foreground">音频质量</span>
            <Select
              value={settings.bilibiliAudioQuality}
              onValueChange={(value) => {
                if (!isBilibiliAudioQuality(value)) return;
                void persistDownloadSettings({ ...settings, bilibiliAudioQuality: value });
              }}
              disabled={!isLoaded || isSaving}
            >
              <SelectTrigger
                aria-label="Bilibili 音频质量"
                className="h-11 w-full min-w-0 justify-between border-0 bg-white/[0.045] px-3 hover:bg-white/[0.075] focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-cyan/25 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="truncate text-xs font-semibold text-foreground">{selectedBilibiliAudioQuality.label}</span>
              </SelectTrigger>
              <SelectContent align="start" sideOffset={6} className="w-[min(26rem,calc(100vw-2rem))] border-white/10 bg-surface-strong p-1">
                {BILIBILI_AUDIO_QUALITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value} textValue={option.label} className="items-start py-2 pl-9 pr-3 focus:bg-cyan/[0.1]">
                    <span className="grid gap-1 text-left">
                      <span className="text-xs font-semibold text-foreground">{option.label}</span>
                      <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        </div>
      ) : null}
      {feedback ? (
        <p className="mt-2 text-xs font-medium leading-5 text-rose-400" role="alert">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

const ALIBABA_SINGAPORE_MODEL_DOCS = "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model&url=2840914";
const ALIBABA_SINGAPORE_WORKSPACES = "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=globalset#/efm/business_management";
const ALIBABA_SINGAPORE_API_KEYS = "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=model#/api-key";

function AiCredentialPanel({
  apiKey,
  configured,
  isLoaded,
  models,
  onGuideOpen,
  onApiKeyChange,
  onConfiguredChange,
  onModelsChange,
}: {
  apiKey: string;
  configured: boolean;
  isLoaded: boolean;
  models: EchoLensDashScopeModelIds;
  onGuideOpen: () => void;
  onApiKeyChange: (apiKey: string) => void;
  onConfiguredChange: (configured: boolean) => void;
  onModelsChange: (models: EchoLensDashScopeModelIds) => void;
}) {
  const [feedback, setFeedback] = useState<Feedback>();
  const [isSaving, setIsSaving] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [modelTests, setModelTests] = useState<Partial<Record<DashScopeModelPurpose, CredentialModelTest | "testing">>>({});
  const [savingPurpose, setSavingPurpose] = useState<DashScopeModelPurpose>();
  const [testingPurposes, setTestingPurposes] = useState<ReadonlySet<DashScopeModelPurpose>>(() => new Set());
  const hasRunningModelTests = testingPurposes.size > 0;

  async function verifyAndSaveApiKey() {
    if (isSaving || hasRunningModelTests) {
      return;
    }
    const nextApiKey = apiKey.trim();
    setIsSaving(true);
    setFeedback(undefined);
    setModelTests(Object.fromEntries(
      (Object.keys(DASHSCOPE_MODEL_OPTIONS) as DashScopeModelPurpose[]).map((purpose) => [purpose, "testing"]),
    ));
    try {
      const testResponse = await fetch("/api/user/settings/ai-credential/test", {
        body: JSON.stringify({ ...(nextApiKey ? { apiKey: nextApiKey } : {}), models }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const testPayload = await readJsonPayload(testResponse, "API Key 测试失败。") as {
        error?: string;
        ok?: boolean;
        results?: CredentialModelTest[];
      };
      const results = testPayload.results ?? [];
      setModelTests(Object.fromEntries(results.map((result) => [result.purpose, result])));
      if (!testResponse.ok || !testPayload.ok) {
        throw new Error(testPayload.error || "至少一个 EchoLens 模型测试未通过，请检查下方结果。");
      }

      if (!nextApiKey) {
        setFeedback({ message: "已保存的 API Key 已通过五类所选模型的最小闭环测试。", tone: "success" });
        return;
      }

      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "aiCredential", value: { apiKey: nextApiKey } }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "自定义 APIKey 保存失败。") as UserSettingsPayload;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "自定义 APIKey 保存失败。");
      }
      const isConfigured = Boolean(payload.settings?.aiCredential?.configured);
      onConfiguredChange(isConfigured);
      onApiKeyChange(nextApiKey);
      setIsVisible(false);
      setFeedback({
        message: isConfigured
          ? "五类所选模型测试通过，API Key 已加密保存。"
          : "自定义 API Key 已移除。",
        tone: "success",
      });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "自定义 APIKey 保存失败。"), tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  async function removeApiKey() {
    if (isSaving || hasRunningModelTests) {
      return;
    }
    setIsSaving(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "aiCredential", value: { apiKey: "" } }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "自定义 APIKey 移除失败。") as UserSettingsPayload;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "自定义 APIKey 移除失败。");
      }
      onConfiguredChange(false);
      onApiKeyChange("");
      setModelTests({});
      setFeedback({ message: "自定义 API Key 已移除。", tone: "success" });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "自定义 APIKey 移除失败。"), tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  async function saveModel(purpose: DashScopeModelPurpose, model: string) {
    if (
      savingPurpose !== undefined
      || testingPurposes.has(purpose)
      || !(DASHSCOPE_MODEL_OPTIONS[purpose] as readonly string[]).includes(model)
    ) {
      return;
    }

    const previousModels = models;
    const nextModels = { ...models, [purpose]: model } as EchoLensDashScopeModelIds;
    onModelsChange(nextModels);
    setModelTests((current) => ({ ...current, [purpose]: undefined }));
    setSavingPurpose(purpose);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "aiModels", value: nextModels }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "模型配置保存失败。") as UserSettingsPayload;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "模型配置保存失败。");
      }
      onModelsChange(normalizeDashScopeModelIds(payload.settings?.aiModels));
    } catch (error) {
      onModelsChange(previousModels);
      setFeedback({ message: readUserFacingError(error, "模型配置保存失败。"), tone: "error" });
    } finally {
      setSavingPurpose(undefined);
    }
  }

  async function testModel(purpose: DashScopeModelPurpose) {
    if (isSaving || savingPurpose === purpose || testingPurposes.has(purpose)) {
      return;
    }

    setTestingPurposes((current) => new Set(current).add(purpose));
    setModelTests((current) => ({ ...current, [purpose]: "testing" }));
    setFeedback(undefined);
    try {
      const nextApiKey = apiKey.trim();
      const response = await fetch("/api/user/settings/ai-credential/test", {
        body: JSON.stringify({ ...(nextApiKey ? { apiKey: nextApiKey } : {}), models, purpose }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJsonPayload(response, "模型测试失败。") as {
        error?: string;
        ok?: boolean;
        results?: CredentialModelTest[];
      };
      const result = payload.results?.find((item) => item.purpose === purpose);
      if (result) {
        setModelTests((current) => ({ ...current, [purpose]: result }));
      }
      if (!response.ok || !payload.ok) {
        if (result) {
          return;
        }
        throw new Error(payload.error || "模型测试失败。");
      }
      if (!result) {
        throw new Error("模型测试未返回结果。");
      }
    } catch (error) {
      setModelTests((current) => ({
        ...current,
        [purpose]: {
          detail: readUserFacingError(error, "模型测试失败。"),
          id: models[purpose],
          ok: false,
          purpose,
        },
      }));
    } finally {
      setTestingPurposes((current) => {
        const next = new Set(current);
        next.delete(purpose);
        return next;
      });
    }
  }

  return (
    <div className="w-full max-w-5xl">
      <div className="border-b border-white/10 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">自定义 APIKey</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              使用自定义阿里云百炼 API Key。已保存的 Key 会直接显示在输入框中，可点击眼睛图标查看。
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold ${configured ? "bg-emerald-500/10 text-emerald-400" : "bg-white/[0.05] text-muted-foreground"}`}>
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
      </div>

      <div className="grid gap-6 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.9fr)]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cable className="size-4 text-cyan" aria-hidden="true" />
            <h3 className="text-xs font-semibold text-foreground">连接信息</h3>
          </div>

          <label htmlFor="dashscope-base-url" className="mt-4 block text-xs font-semibold text-foreground">
            DASHSCOPE_BASE_URL
          </label>
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <input
              id="dashscope-base-url"
              value={DASHSCOPE_FIXED_BASE_URL}
              readOnly
              className="h-10 min-w-0 rounded-md border border-white/10 bg-black/25 px-3 font-mono text-[11px] text-muted-foreground outline-none"
            />
            <span className="rounded-md bg-cyan/[0.1] px-2 py-1 text-[11px] font-semibold text-cyan">固定</span>
          </div>

          <label htmlFor="dashscope-api-key" className="mt-4 block text-xs font-semibold text-foreground">
            DASHSCOPE_API_KEY
          </label>
          <div className="mt-2 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id="dashscope-api-key"
                type={isVisible ? "text" : "password"}
                value={apiKey}
                onChange={(event) => {
                  onApiKeyChange(event.target.value);
                  setModelTests({});
                  setFeedback(undefined);
                }}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                disabled={isSaving || hasRunningModelTests}
                spellCheck={false}
                placeholder={configured ? "输入新 Key 可替换已保存凭证" : "粘贴新加坡 EchoLens 业务空间的 API Key"}
                className="h-10 w-full rounded-md border border-cyan/40 bg-black/25 py-2 pl-3 pr-20 font-mono text-xs text-foreground outline-none transition placeholder:font-sans placeholder:text-muted-foreground/65 hover:border-cyan/55 focus:border-cyan/70 focus:ring-2 focus:ring-cyan/15"
              />
              {configured ? (
                <button
                  type="button"
                  onClick={() => void removeApiKey()}
                  disabled={isSaving || hasRunningModelTests}
                  className="absolute inset-y-0 right-10 inline-flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="移除已保存 API Key"
                  title="移除已保存 API Key"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setIsVisible((current) => !current)}
                className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label={isVisible ? "隐藏 API Key" : "显示 API Key"}
                title={isVisible ? "隐藏 API Key" : "显示 API Key"}
              >
                {isVisible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void verifyAndSaveApiKey()}
              disabled={!isLoaded || isSaving || hasRunningModelTests || (!configured && !apiKey.trim())}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            >
              {isSaving ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
              {isSaving ? "测试中" : configured && !apiKey.trim() ? "验证已保存 Key" : "验证并保存"}
            </button>
          </div>
          {feedback ? (
            <p className={`mt-3 text-xs font-medium leading-5 ${feedback.tone === "error" ? "text-rose-400" : "text-emerald-400"}`} role={feedback.tone === "error" ? "alert" : "status"}>
              {feedback.message}
            </p>
          ) : null}

          <div className="mt-5">
            <div className="flex items-center gap-2">
              <BrainCircuit className="size-4 text-cyan" aria-hidden="true" />
              <h3 className="text-xs font-semibold text-foreground">模型配置</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(Object.keys(DASHSCOPE_MODEL_OPTIONS) as DashScopeModelPurpose[]).map((purpose) => {
                const metadata = DASHSCOPE_MODEL_METADATA[purpose];
                const modelTest = modelTests[purpose];
                const selectedModel = models[purpose];
                const isTesting = testingPurposes.has(purpose);
                return (
                  <div key={purpose} className="rounded-md border border-white/10 px-3 py-3">
                    <div className="flex items-start justify-between gap-2 px-2.5">
                      <span className="text-xs font-semibold text-foreground">{metadata.label}</span>
                      <div className="flex items-center gap-1.5">
                        <ModelTestStatus status={modelTest} />
                        <button
                          type="button"
                          onClick={() => void testModel(purpose)}
                          disabled={!isLoaded || isSaving || savingPurpose === purpose || isTesting}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-cyan/[0.1] hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`测试${metadata.label}`}
                          title={`测试${metadata.label}`}
                        >
                          {isTesting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <TestTube2 className="size-3.5" aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                    <Select
                      value={selectedModel}
                      onValueChange={(model) => void saveModel(purpose, model)}
                      disabled={!isLoaded || isSaving || savingPurpose !== undefined || isTesting}
                    >
                      <SelectTrigger
                        aria-label={metadata.label}
                        className="mt-2 h-9 w-full min-w-0 justify-between border-white/10 bg-black/25 px-2.5 hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-cyan/25"
                      >
                        <code className="truncate text-[11px] text-cyan">{selectedModel}</code>
                      </SelectTrigger>
                      <SelectContent
                        align="start"
                        sideOffset={5}
                        className="w-max min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] border-white/10 bg-surface-strong p-1"
                      >
                        {DASHSCOPE_MODEL_OPTIONS[purpose].map((model) => (
                          <SelectItem
                            key={model}
                            value={model}
                            className="py-2 pl-9 pr-3 focus:bg-cyan/[0.1]"
                          >
                            <code className="whitespace-nowrap text-xs text-foreground">{model}</code>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {modelTest !== undefined && modelTest !== "testing" && !modelTest.ok ? (
                      <p className="mt-1 text-[11px] text-rose-400">
                        {modelTest.detail}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="min-w-0">
           <div className="flex items-center gap-2">
             <Bot className="size-4 text-cyan" aria-hidden="true" />
             <h3 className="text-xs font-semibold text-foreground">创建正确 API Key</h3>
           </div>

           <button
             type="button"
             onClick={onGuideOpen}
             className="group relative mt-3 block w-full overflow-hidden rounded-md border border-white/10 bg-white/[0.025] text-left outline-none transition hover:border-cyan/45 focus-visible:border-cyan/60 focus-visible:ring-2 focus-visible:ring-cyan/20"
             aria-label="放大查看创建正确 API Key 的操作流程图"
             title="放大查看操作流程图"
           >
             <Image
               src="/dashscope-api-key-guide.png"
               alt="EchoLens 新加坡地域 API Key 创建流程图"
               width={1680}
               height={942}
               loading="eager"
               className="h-auto w-full"
               sizes="(min-width: 1024px) 40vw, 100vw"
             />
             <span className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white backdrop-blur-sm transition group-hover:border-cyan/50 group-hover:text-cyan">
               <Maximize2 className="size-4" aria-hidden="true" />
             </span>
           </button>

           <div className="mt-3 grid gap-2">
            <GuideDisclosure title="1. 选择新加坡地域" defaultOpen>
              <ol className="grid list-decimal gap-1 pl-4">
                <li>登录阿里云百炼控制台，查看页面右上角的地域选择器。</li>
                <li>选择“新加坡”，等待控制台重新加载。</li>
                <li>确认浏览器地址包含 <code className="text-cyan">ap-southeast-1</code>。地域之间的业务空间、API Key 和模型资源互不通用。</li>
              </ol>
              <p className="mt-2 border-l-2 border-cyan/50 pl-2 text-xs leading-5 text-cyan">
                新加坡地域可用模型非常丰富，且多种模型提供免费 Token 额度；具体模型与额度以控制台实时展示为准。
              </p>
              <GuideLink href="https://modelstudio.console.aliyun.com/ap-southeast-1?tab=model#/model-market">打开新加坡百炼控制台</GuideLink>
            </GuideDisclosure>
            <GuideDisclosure title="2. 创建或确认 EchoLens 业务空间">
              <ol className="grid list-decimal gap-1 pl-4">
                <li>进入“全局管理”，打开“业务空间管理”。主账号或拥有百炼超级管理员权限的 RAM 用户才能创建空间。</li>
                <li>点击“新建业务空间”，名称填写 <code className="text-cyan">EchoLens</code>，不要选择或改用“默认业务空间”。</li>
                <li>进入新空间并确认地域仍是新加坡。</li>
              </ol>
              <GuideLink href={ALIBABA_SINGAPORE_WORKSPACES}>打开新加坡业务空间管理</GuideLink>
            </GuideDisclosure>
            <GuideDisclosure title="3. 授权模型并设置空间限流">
              <ol className="grid list-decimal gap-1 pl-4">
                <li>在 EchoLens 业务空间打开“模型列表”，逐一搜索本页列出的四个模型。</li>
                <li>在每个模型的“模型调用”列打开授权。这里只需要调用权限，不需要开启模型训练或部署权限。</li>
                <li>在“当前空间限流”中分别可选设置请求数限流和 Token 限流。按账号总配额和预计并发分配，并保留突发流量余量。</li>
                <li>保存后再次确认四个模型均显示“已授权”。默认业务空间无法限制模型调用和设置空间限流，这是必须使用非默认空间的原因。</li>
              </ol>
              <GuideLink href="https://help.aliyun.com/zh/model-studio/permission-management-overview">查看业务空间、模型权限与限流官方说明</GuideLink>
              <GuideLink href={ALIBABA_SINGAPORE_MODEL_DOCS}>查看新加坡模型官方文档</GuideLink>
            </GuideDisclosure>
            <GuideDisclosure title="4. 创建带模型范围的 API Key">
              <ol className="grid list-decimal gap-1 pl-4">
                <li>保持地域为新加坡，进入“API Key”，点击“创建 API Key”。</li>
                <li>“归属业务空间”选择 <code className="text-cyan">EchoLens</code>，描述可填写“EchoLens 本地调用”。</li>
                <li>“权限”选择“自定义”。在可访问模型中只勾选本页列出的四个模型，不要把 Key 创建到默认业务空间。</li>
                <li>有固定出口 IP 时配置 IP 白名单；出口不固定时保留控制台默认值，避免误拦截。</li>
                <li>确认并创建，立即复制完整 Key。关闭弹窗后通常无法再次查看完整明文。</li>
              </ol>
              <GuideLink href={ALIBABA_SINGAPORE_API_KEYS}>打开新加坡 API Key 页面</GuideLink>
              <GuideLink href="https://help.aliyun.com/zh/model-studio/get-api-key">查看创建 API Key 官方说明</GuideLink>
            </GuideDisclosure>
            <GuideDisclosure title="5. 保存前完成最终核对">
              <ol className="grid list-decimal gap-1 pl-4">
                <li>地域显示“新加坡”，地址包含 <code className="text-cyan">ap-southeast-1</code>。</li>
                <li>Key 归属 EchoLens 非默认业务空间，空间调用地址与本页固定地址一致。</li>
                <li>空间已授权四个固定模型并设置限流，Key 的自定义模型范围也包含同样四个模型。</li>
                <li>把 Key 粘贴到左侧并保存，不要通过聊天、截图或日志分享 Key。</li>
              </ol>
            </GuideDisclosure>
          </div>

        </div>
      </div>
    </div>
  );
}

function ModelTestStatus({ status }: { status: CredentialModelTest | "testing" | undefined }) {
  if (status === "testing") {
    return <StatusIndicator color="bg-amber" label="测试中" />;
  }
  if (status?.ok === true) {
    return <StatusIndicator color="bg-emerald-400" label="测试成功" />;
  }
  if (status?.ok === false) {
    return <StatusIndicator color="bg-rose-400" label="测试失败" />;
  }
  return <StatusIndicator color="bg-white/30" label="未测试" />;
}

function StatusIndicator({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function GuideDisclosure({ children, defaultOpen = false, title }: { children: React.ReactNode; defaultOpen?: boolean; title: string }) {
  return (
    <details className="group rounded-md border border-white/10 bg-white/[0.02]" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-cyan/25 [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-4 shrink-0 text-cyan transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-white/10 px-3 py-2.5 text-xs leading-5 text-muted-foreground">{children}</div>
    </details>
  );
}

function GuideLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold text-cyan hover:underline hover:underline-offset-4">
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

function ApiTokensPanel({ isLoaded }: { isLoaded: boolean }) {
  const [tokens, setTokens] = useState<ApiAccessTokenRecord[]>([]);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const [isWithoutExpiry, setIsWithoutExpiry] = useState(true);
  const [editingToken, setEditingToken] = useState<ApiAccessTokenRecord>();
  const [revealedToken, setRevealedToken] = useState<{ id: string; value: string }>();
  const [copiedTokenId, setCopiedTokenId] = useState<string>();
  const [tokenPendingDeletion, setTokenPendingDeletion] = useState<ApiAccessTokenRecord>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!copiedTokenId) return;
    const timeout = window.setTimeout(() => setCopiedTokenId(undefined), 1_500);
    return () => window.clearTimeout(timeout);
  }, [copiedTokenId]);

  useEffect(() => {
    if (!isLoaded) return;
    let isActive = true;
    void (async () => {
      setIsBusy(true);
      setFeedback(undefined);
      try {
        const response = await fetch("/api/user/api-tokens", { cache: "no-store" });
        const payload = await readJsonPayload(response, "API 访问令牌加载失败。") as ApiAccessTokensPayload;
        if (!response.ok) throw new Error(getApiError(payload)?.error || "API 访问令牌加载失败。");
        if (isActive) setTokens(payload.tokens ?? []);
      } catch (error) {
        if (isActive) setFeedback({ message: readUserFacingError(error, "API 访问令牌加载失败。"), tone: "error" });
      } finally {
        if (isActive) setIsBusy(false);
      }
    })();
    return () => {
      isActive = false;
    };
  }, [isLoaded]);

  async function createToken() {
    if (isBusy) return;
    setIsBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch("/api/user/api-tokens", {
        body: JSON.stringify({ name, expiresAt: isWithoutExpiry ? null : parseDateInput(expiresAt) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJsonPayload(response, "API 访问令牌创建失败。") as ApiAccessTokensPayload;
      if (!response.ok || !payload.record || !payload.token) {
        throw new Error(getApiError(payload)?.error || "API 访问令牌创建失败。");
      }
      setTokens((current) => [payload.record!, ...current]);
      setIsCreateDialogOpen(false);
      setName("");
      setExpiresAt("");
      setIsWithoutExpiry(true);
      setFeedback({ message: "令牌已创建。", tone: "success" });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "API 访问令牌创建失败。"), tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function updateToken() {
    if (!editingToken || isBusy || !name.trim()) return;
    setIsBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/user/api-tokens/${encodeURIComponent(editingToken.id)}`, {
        body: JSON.stringify({ name, expiresAt: isWithoutExpiry ? null : parseDateInput(expiresAt) }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonPayload(response, "API 访问令牌更新失败。") as { token?: ApiAccessTokenRecord };
      if (!response.ok || !payload.token) {
        throw new Error(getApiError(payload)?.error || "API 访问令牌更新失败。");
      }
      setTokens((current) => current.map((item) => item.id === payload.token!.id ? payload.token! : item));
      setEditingToken(undefined);
      setFeedback({ message: "令牌信息已更新。", tone: "success" });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "API 访问令牌更新失败。"), tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  function openCreateDialog() {
    setEditingToken(undefined);
    setName("");
    setExpiresAt("");
    setCalendarMonth(new Date());
    setIsWithoutExpiry(true);
    setIsCreateDialogOpen(true);
  }

  function openEditDialog(token: ApiAccessTokenRecord) {
    setIsCreateDialogOpen(false);
    setEditingToken(token);
    setName(token.name);
    setExpiresAt(token.expiresAt ? toDateInputValue(token.expiresAt) : "");
    setCalendarMonth(token.expiresAt ? new Date(token.expiresAt) : new Date());
    setIsWithoutExpiry(!token.expiresAt);
  }

  async function resetToken(token: ApiAccessTokenRecord) {
    if (isBusy) return;
    setIsBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/user/api-tokens/${encodeURIComponent(token.id)}`, {
        body: JSON.stringify({ reset: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonPayload(response, "API 访问令牌重置失败。") as ApiAccessTokensPayload;
      if (!response.ok || !payload.record || !payload.token) {
        throw new Error(getApiError(payload)?.error || "API 访问令牌重置失败。");
      }
      setTokens((current) => current.map((item) => item.id === payload.record!.id ? payload.record! : item));
      setFeedback({ message: "令牌已重置，旧令牌立即失效。", tone: "success" });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "API 访问令牌重置失败。"), tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteToken() {
    if (isBusy || !tokenPendingDeletion) return;
    const token = tokenPendingDeletion;
    setIsBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/user/api-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      const payload = await readJsonPayload(response, "API 访问令牌删除失败。") as { deleted?: boolean };
      if (!response.ok || !payload.deleted) {
        throw new Error(getApiError(payload)?.error || "API 访问令牌删除失败。");
      }
      setTokens((current) => current.filter((item) => item.id !== token.id));
      setTokenPendingDeletion(undefined);
      setFeedback({ message: `「${token.name}」已删除。`, tone: "success" });
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "API 访问令牌删除失败。"), tone: "error" });
    } finally {
      setIsBusy(false);
    }
  }

  async function readPlainToken(token: ApiAccessTokenRecord): Promise<string | undefined> {
    setIsBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(`/api/user/api-tokens/${encodeURIComponent(token.id)}`, { cache: "no-store" });
      const payload = await readJsonPayload(response, "API 访问令牌读取失败。") as { token?: string };
      if (!response.ok || !payload.token) {
        throw new Error(getApiError(payload)?.error || "API 访问令牌读取失败。");
      }
      return payload.token;
    } catch (error) {
      setFeedback({ message: readUserFacingError(error, "API 访问令牌读取失败。"), tone: "error" });
      return undefined;
    } finally {
      setIsBusy(false);
    }
  }

  async function revealToken(token: ApiAccessTokenRecord) {
    const plain = await readPlainToken(token);
    if (plain) setRevealedToken({ id: token.id, value: plain });
  }

  async function copyToken(token: ApiAccessTokenRecord) {
    const plain = await readPlainToken(token);
    if (!plain) return;
    await navigator.clipboard.writeText(plain);
    setCopiedTokenId(token.id);
  }

  const dialogOpen = isCreateDialogOpen || editingToken !== undefined;
  const dialogTitle = editingToken ? "编辑 API 访问令牌" : "新建 API 访问令牌";

  return (
    <div className="w-full max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">API 访问令牌</h2>
          <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-foreground">
            生成个人 API 访问令牌（access token）可用于调用 <Link href="/docs?section=api-tokens" className="font-semibold text-cyan hover:text-cyan/80 hover:underline hover:underline-offset-4">EchoLens Open API</Link>。个人 API 访问令牌对当前账号下可访问的数据进行匹配授权。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateDialog}
          disabled={!isLoaded}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <KeyRound className="size-3.5" aria-hidden="true" />
          新建
        </button>
      </div>

      {feedback ? (
        <p className={`mt-3 text-xs font-medium leading-5 ${feedback.tone === "success" ? "text-emerald-400" : feedback.tone === "error" ? "text-rose-400" : "text-amber"}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
        </p>
      ) : null}

      <div className="mt-5 border-y border-white/10">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(7rem,0.75fr)_4.5rem] gap-3 bg-white/[0.025] px-3 py-2.5 text-xs font-semibold text-muted-foreground sm:px-4 lg:grid-cols-[minmax(6rem,0.65fr)_8.5rem_8.5rem_8.5rem_minmax(9rem,1fr)_4.5rem] lg:gap-3">
          <span>名称</span>
          <span className="hidden lg:block">创建时间</span>
          <span className="hidden lg:block">最后更新</span>
          <span className="hidden lg:block">上次使用</span>
          <span>API Key</span>
          <span className="sr-only">操作</span>
        </div>
        {tokens.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无 API 访问令牌。</div>
        ) : tokens.map((token) => (
          <div key={token.id} className="grid grid-cols-[minmax(0,1fr)_minmax(7rem,0.75fr)_4.5rem] items-center gap-3 border-t border-white/10 px-3 py-3.5 sm:px-4 lg:grid-cols-[minmax(6rem,0.65fr)_8.5rem_8.5rem_8.5rem_minmax(9rem,1fr)_4.5rem]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">{token.name}</span>
                <TokenStatus token={token} />
              </div>
            </div>
            <span className="hidden text-xs text-muted-foreground lg:block">{formatTokenDate(token.createdAt)}</span>
            <span className="hidden text-xs text-muted-foreground lg:block">{formatTokenDate(token.updatedAt)}</span>
            <span className="hidden text-xs text-muted-foreground lg:block">{token.lastUsedAt ? formatTokenDate(token.lastUsedAt) : "从未使用"}</span>
            <div className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 flex-1 break-all text-xs text-foreground">{revealedToken?.id === token.id ? revealedToken.value : `${token.prefix}…`}</code>
              <button type="button" onClick={() => void revealToken(token)} disabled={isBusy} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan disabled:opacity-35" aria-label={`查看 ${token.name} 明文`} title="查看明文">
                <Eye className="size-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => void copyToken(token)} disabled={isBusy} className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md transition hover:bg-white/[0.06] disabled:opacity-35 ${copiedTokenId === token.id ? "text-emerald-400" : "text-muted-foreground hover:text-cyan"}`} aria-label={copiedTokenId === token.id ? `${token.name} 已复制` : `复制 ${token.name}`} title={copiedTokenId === token.id ? "已复制" : "复制令牌"}>
                {copiedTokenId === token.id ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
              </button>
            </div>
            <div className="flex items-center justify-end gap-1">
              <button type="button" onClick={() => openEditDialog(token)} disabled={isBusy} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan disabled:opacity-35" aria-label={`编辑 ${token.name}`} title="编辑">
                <Pencil className="size-3.5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => setTokenPendingDeletion(token)} disabled={isBusy} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-35" aria-label={`删除 ${token.name}`} title="删除">
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {tokenPendingDeletion ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="alertdialog" aria-modal="true" aria-labelledby="delete-api-token-title" aria-describedby="delete-api-token-description">
          <div className="w-full max-w-md rounded-lg border border-white/10 bg-surface-strong p-5 shadow-2xl shadow-black/50 sm:p-6">
            <h3 id="delete-api-token-title" className="text-base font-semibold text-foreground">删除 API 访问令牌？</h3>
            <p id="delete-api-token-description" className="mt-2 text-sm leading-6 text-muted-foreground">
              删除「{tokenPendingDeletion.name}」后，使用该令牌的客户端将立即失去访问权限。此操作无法撤销。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={() => setTokenPendingDeletion(undefined)} disabled={isBusy} className="h-9 rounded-md px-3 text-xs font-semibold text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50">取消</button>
              <button type="button" onClick={() => void deleteToken()} disabled={isBusy} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-rose-500 px-4 text-xs font-semibold text-white transition hover:bg-rose-400 disabled:opacity-50">
                {isBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="api-token-dialog-title">
          <div className="w-full max-w-[32.5rem] rounded-lg border border-white/10 bg-surface-strong p-5 shadow-2xl shadow-black/50 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <h3 id="api-token-dialog-title" className="text-base font-semibold text-foreground">{dialogTitle}</h3>
              <button type="button" onClick={() => { setIsCreateDialogOpen(false); setEditingToken(undefined); }} className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground" aria-label="关闭">
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <label className="mt-6 block text-sm font-semibold text-foreground" htmlFor="api-token-name">名称 <span className="text-rose-400">*</span></label>
            <input id="api-token-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="给令牌一个名称，记录该令牌的用途" className="api-token-name-input mt-2 h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/65 focus:border-cyan/60 focus:ring-2 focus:ring-cyan/15" autoComplete="off" spellCheck={false} autoFocus />
            <fieldset className="mt-5">
              <legend className="text-sm font-semibold text-foreground">有效期 <span className="text-rose-400">*</span></legend>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Popover.Root open={isDatePickerOpen} onOpenChange={setIsDatePickerOpen}>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      disabled={isWithoutExpiry}
                      className="inline-flex h-10 min-w-36 items-center justify-between gap-3 rounded-md border border-white/10 bg-black/20 px-3 text-left text-sm text-foreground outline-none transition hover:border-white/20 focus-visible:border-cyan/60 focus-visible:ring-2 focus-visible:ring-cyan/15 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <span className={expiresAt ? "text-foreground" : "text-muted-foreground"}>{expiresAt ? format(new Date(`${expiresAt}T00:00:00`), "yyyy 年 M 月 d 日", { locale: zhCN }) : "选择日期"}</span>
                      <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content align="start" sideOffset={8} className="z-50 w-[19rem] rounded-md border border-white/10 bg-surface-strong p-0 shadow-xl shadow-black/35 outline-none">
                      <div className="flex h-12 items-center justify-between border-b border-white/10 px-3">
                        <div className="flex items-center gap-1">
                          <Select
                            value={String(calendarMonth.getFullYear())}
                            onValueChange={(value) => setCalendarMonth((current) => new Date(Number(value), current.getMonth(), 1))}
                          >
                            <SelectTrigger aria-label="选择年份" className="h-8 min-w-[5.75rem] justify-between bg-white/[0.04] px-2 text-xs font-semibold hover:bg-white/[0.075] focus-visible:ring-cyan/20">
                              <span>{calendarMonth.getFullYear()} 年</span>
                            </SelectTrigger>
                            <SelectContent align="start" sideOffset={6} className="z-[60] max-h-56 min-w-[var(--radix-select-trigger-width)] border-white/10 bg-surface-strong p-1 shadow-xl shadow-black/40">
                              {Array.from({ length: 11 }, (_, index) => new Date().getFullYear() + index).map((year) => (
                                <SelectItem key={year} value={String(year)} className="py-2 pl-8 pr-3 text-xs font-semibold focus:bg-cyan/[0.12]">
                                  {year} 年
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={String(calendarMonth.getMonth())}
                            onValueChange={(value) => setCalendarMonth((current) => new Date(current.getFullYear(), Number(value), 1))}
                          >
                            <SelectTrigger aria-label="选择月份" className="h-8 min-w-[4.5rem] justify-between bg-white/[0.04] px-2 text-xs font-semibold hover:bg-white/[0.075] focus-visible:ring-cyan/20">
                              <span>{calendarMonth.getMonth() + 1} 月</span>
                            </SelectTrigger>
                            <SelectContent align="start" sideOffset={6} className="z-[60] max-h-56 min-w-[var(--radix-select-trigger-width)] border-white/10 bg-surface-strong p-1 shadow-xl shadow-black/40">
                              {Array.from({ length: 12 }, (_, index) => (
                                <SelectItem key={index} value={String(index)} className="py-2 pl-8 pr-3 text-xs font-semibold focus:bg-cyan/[0.12]">
                                  {index + 1} 月
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" aria-label="上个月" disabled={calendarMonth.getFullYear() === new Date().getFullYear() && calendarMonth.getMonth() === new Date().getMonth()} onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan disabled:cursor-not-allowed disabled:opacity-30">
                            <ChevronLeft className="size-4" aria-hidden="true" />
                          </button>
                          <button type="button" aria-label="下个月" onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-cyan">
                            <ChevronRight className="size-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <Calendar
                        mode="single"
                        month={calendarMonth}
                        onMonthChange={setCalendarMonth}
                        selected={expiresAt ? new Date(`${expiresAt}T00:00:00`) : undefined}
                        disabled={{ before: new Date() }}
                        locale={zhCN}
                        classNames={{ month_caption: "hidden", nav: "hidden" }}
                        onSelect={(date) => {
                          if (!date) return;
                          setExpiresAt(toDateInputValue(date.getTime()));
                          setCalendarMonth(date);
                          setIsWithoutExpiry(false);
                          setIsDatePickerOpen(false);
                        }}
                      />
                      <div className="border-t border-white/10 px-3 py-2 text-center">
                        <button type="button" onClick={() => { setExpiresAt(toDateInputValue(Date.now())); setIsWithoutExpiry(false); setIsDatePickerOpen(false); }} className="text-xs font-semibold text-cyan transition hover:text-amber">今天</button>
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
                <label className="inline-flex h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-foreground">
                  <span className="relative shrink-0">
                    <input
                      type="checkbox"
                      checked={isWithoutExpiry}
                      onChange={(event) => setIsWithoutExpiry(event.target.checked)}
                      className="peer absolute inset-0 z-10 size-[1.05rem] cursor-pointer opacity-0"
                    />
                    <span
                      aria-hidden="true"
                      className="flex size-[1.05rem] items-center justify-center rounded-[0.28rem] border border-white/28 bg-white/[0.03] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.06),0_0_0_1px_rgb(0_0_0_/_0.2)] transition peer-hover:border-cyan/55 peer-focus-visible:border-cyan/70 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan/20 peer-checked:border-cyan/80 peer-checked:bg-white/[0.02] peer-checked:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),0_0_0_1px_rgb(0_0_0_/_0.18),0_0_16px_rgb(34_211_238_/_0.12)] peer-checked:[&>svg]:opacity-100"
                    >
                      <Check className="size-[0.82rem] text-cyan opacity-0 drop-shadow-[0_0_6px_rgba(34,211,238,0.45)] transition duration-150 ease-out" strokeWidth={3.4} />
                    </span>
                  </span>
                  无期限
                </label>
              </div>
            </fieldset>
            <div className="mt-7 flex items-center justify-between gap-3">
              {editingToken ? <button type="button" onClick={() => void resetToken(editingToken)} disabled={isBusy} className="text-xs font-semibold text-cyan hover:text-cyan/80 disabled:opacity-50">重置令牌</button> : <span />}
              <div className="flex gap-2">
                <button type="button" onClick={() => { setIsCreateDialogOpen(false); setEditingToken(undefined); }} className="h-9 rounded-md px-3 text-xs font-semibold text-muted-foreground hover:bg-white/[0.06] hover:text-foreground">取消</button>
                <button type="button" onClick={() => void (editingToken ? updateToken() : createToken())} disabled={isBusy || !name.trim()} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-cyan px-4 text-xs font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
                  {isBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
                  {editingToken ? "保存" : "创建"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TokenStatus({ token }: { token: ApiAccessTokenRecord }) {
  if (token.isExpired) return <StatusIndicator color="bg-amber" label="已过期" />;
  return <StatusIndicator color="bg-emerald-400" label="可用" />;
}

function parseDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateInputValue(value: number): string {
  const date = new Date(value);
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 10);
}

function formatTokenDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function GuideImageModal({
  alt,
  ariaLabel,
  height,
  isOpen,
  onClose,
  onZoomChange,
  src,
  title,
  width,
  zoom,
}: {
  alt: string;
  ariaLabel: string;
  height: number;
  isOpen: boolean;
  onClose: () => void;
  onZoomChange: (updater: (current: number) => number) => void;
  src: string;
  title: string;
  width: number;
  zoom: number;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-black px-3 sm:px-4">
        <span className="truncate text-sm font-semibold text-white">{title}</span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onZoomChange((current) => Math.max(0.5, current - 0.25))}
            disabled={zoom <= 0.5}
            className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="缩小图片"
            title="缩小"
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-white/70">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => onZoomChange((current) => Math.min(3, current + 0.25))}
            disabled={zoom >= 3}
            className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="放大图片"
            title="放大"
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(() => 1)}
            className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white"
            aria-label="重置图片大小"
            title="重置"
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white"
            aria-label="关闭图片"
            title="关闭"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        <div className="flex min-h-full min-w-full items-center justify-center">
          <div className="shrink-0 transition-[width] duration-150" style={{ width: `${zoom * 100}%` }}>
            <Image src={src} alt={alt} width={width} height={height} className="h-auto w-full" priority />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage({
  initialSection = "aiCredential",
}: {
  initialSection?: SettingsSection;
}) {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [aiCredentialConfigured, setAiCredentialConfigured] = useState(false);
  const [aiCredentialApiKey, setAiCredentialApiKey] = useState("");
  const [aiModels, setAiModels] = useState<EchoLensDashScopeModelIds>(DEFAULT_DASHSCOPE_MODELS);
  const [credentialMethod, setCredentialMethod] = useState<CredentialMethod>("automatic");
  const [bilibiliCredentialMethod, setBilibiliCredentialMethod] = useState<CredentialMethod>("automatic");
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>("idle");
  const [bilibiliCredentialStatus, setBilibiliCredentialStatus] = useState<CredentialStatus>("idle");
  const [bilibiliQrSession, setBilibiliQrSession] = useState<BilibiliQrSession>();
  const [isBilibiliQrLoading, setIsBilibiliQrLoading] = useState(false);
  const [isBilibiliQrPolling, setIsBilibiliQrPolling] = useState(false);
  const [douyinFeedback, setDouyinFeedback] = useState<Feedback>();
  const [bilibiliFeedback, setBilibiliFeedback] = useState<Feedback>();
  const [guideZoom, setGuideZoom] = useState(1);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [apiGuideZoom, setApiGuideZoom] = useState(1);
  const [isApiGuideOpen, setIsApiGuideOpen] = useState(false);
  const [windowsArchitecture, setWindowsArchitecture] = useState<WindowsArchitecture>();
  const detectedPlatform = useSyncExternalStore(
    subscribeToPlatform,
    detectSupportedPlatform,
    () => undefined,
  );
  const [settings, setSettings] = useState<DouyinSettings>({ cookie: "" });
  const [bilibiliSettings, setBilibiliSettings] = useState<BilibiliSettings>({ cookie: "" });
  const [downloadSettings, setDownloadSettings] = useState<DownloadSettings>({
    bilibiliAudioQuality: DEFAULT_BILIBILI_AUDIO_QUALITY,
    bilibiliVideoCodec: DEFAULT_BILIBILI_VIDEO_CODEC,
    bilibiliVideoQuality: DEFAULT_BILIBILI_VIDEO_QUALITY,
    directoryPath: "",
    organization: DEFAULT_DOWNLOAD_ORGANIZATION,
    videoQuality: DEFAULT_DOWNLOAD_VIDEO_QUALITY,
  });
  const [isCredentialVisible, setIsCredentialVisible] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isDouyinSaving, setIsDouyinSaving] = useState(false);
  const [isBilibiliSaving, setIsBilibiliSaving] = useState(false);
  const douyinFeedbackRef = useRef<HTMLParagraphElement>(null);
  const bilibiliFeedbackRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    douyinFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [douyinFeedback]);

  useEffect(() => {
    bilibiliFeedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [bilibiliFeedback]);

  useEffect(() => {
    const isAnyGuideOpen = isGuideOpen || isApiGuideOpen;
    if (!isAnyGuideOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsGuideOpen(false);
        setIsApiGuideOpen(false);
      } else if (event.key === "+" || event.key === "=") {
        if (isGuideOpen) {
          setGuideZoom((current) => Math.min(3, current + 0.25));
        } else {
          setApiGuideZoom((current) => Math.min(3, current + 0.25));
        }
      } else if (event.key === "-") {
        if (isGuideOpen) {
          setGuideZoom((current) => Math.max(0.5, current - 0.25));
        } else {
          setApiGuideZoom((current) => Math.max(0.5, current - 0.25));
        }
      } else if (event.key === "0") {
        if (isGuideOpen) {
          setGuideZoom(1);
        } else {
          setApiGuideZoom(1);
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isApiGuideOpen, isGuideOpen]);

  useEffect(() => {
    if (detectedPlatform !== "windows") {
      return;
    }
    let isActive = true;
    const clientNavigator = navigator as Navigator & { userAgentData?: ClientUserAgentData };

    async function resolveArchitecture() {
      let highEntropy: { architecture?: string; bitness?: string } = {};
      try {
        highEntropy = await clientNavigator.userAgentData?.getHighEntropyValues?.([
          "architecture",
          "bitness",
        ]) ?? {};
      } catch {
        // User-Agent fallback remains compatible through Windows x64 emulation.
      }
      if (isActive) {
        setWindowsArchitecture(detectWindowsArchitecture({
          ...highEntropy,
          userAgent: navigator.userAgent,
        }));
      }
    }

    void resolveArchitecture();
    return () => {
      isActive = false;
    };
  }, [detectedPlatform]);

  useEffect(() => {
    let isActive = true;

    async function loadSettingsPage() {
      try {
        const userResponse = await fetch("/api/auth/me", { cache: "no-store" });
        if (!userResponse.ok) {
          router.replace(`/login?next=${encodeURIComponent("/settings")}`);
          return;
        }

        const [settingsResponse, credentialResponse] = await Promise.all([
          fetch("/api/user/settings", { cache: "no-store" }),
          fetch("/api/user/settings/ai-credential", { cache: "no-store" }),
        ]);
        const settingsPayload = await readJsonPayload(settingsResponse, "设置加载失败。") as UserSettingsPayload;
        if (!settingsResponse.ok) {
          throw new Error(getApiError(settingsPayload)?.error || "设置加载失败。");
        }
        const credentialPayload = await readJsonPayload(credentialResponse, "API Key 加载失败。") as AiCredentialPayload;
        if (!credentialResponse.ok) {
          throw new Error("API Key 加载失败。");
        }

        if (isActive) {
          const loadedSettings = normalizeDouyinSettings(settingsPayload.settings?.douyin);
          const loadedBilibiliSettings = normalizeBilibiliSettings(settingsPayload.settings?.bilibili);
          const loadedDownloadSettings = normalizeDownloadSettings(settingsPayload.settings?.download);
          setSettings(loadedSettings);
          setBilibiliSettings(loadedBilibiliSettings);
          setAiCredentialConfigured(Boolean(settingsPayload.settings?.aiCredential?.configured));
          setAiCredentialApiKey(typeof credentialPayload.apiKey === "string" ? credentialPayload.apiKey : "");
          setAiModels(normalizeDashScopeModelIds(settingsPayload.settings?.aiModels));
          setDownloadSettings(loadedDownloadSettings);
          cacheDownloadOrganization(loadedDownloadSettings.organization);
          setCredentialStatus(
            loadedSettings.credentialStatus === "valid"
              ? "valid"
              : loadedSettings.credentialStatus === "invalid"
                ? "invalid"
                : "idle",
          );
          setBilibiliCredentialStatus(
            loadedBilibiliSettings.credentialStatus === "valid"
              ? "valid"
              : loadedBilibiliSettings.credentialStatus === "invalid"
                ? "invalid"
                : "idle",
          );
          setIsLoaded(true);
        }
      } catch (loadError) {
        if (isActive) {
          setDouyinFeedback({
            message: readUserFacingError(loadError, "设置加载失败。"),
            tone: "error",
          });
          setIsLoaded(true);
        }
      }
    }

    void loadSettingsPage();
    return () => {
      isActive = false;
    };
  }, [router]);

  async function saveSettings(nextSettings: DouyinSettings = settings) {
    setIsDouyinSaving(true);
    setDouyinFeedback(undefined);
    try {
      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "douyin", value: nextSettings }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "抖音账号凭证保存失败。") as UserSettingsPayload;
      if (!response.ok) {
        const apiError = getApiError(payload);
        if (apiError?.code === "LOGIN_REQUIRED" || apiError?.code === "INVALID_COOKIE") {
          setCredentialStatus("invalid");
        } else {
          setCredentialStatus("unavailable");
        }
        throw new Error(apiError?.error || "抖音账号凭证保存失败。");
      }
      const savedSettings = normalizeDouyinSettings(payload.settings?.douyin);
      setSettings(savedSettings);
      setCredentialStatus(savedSettings.cookie ? "valid" : "idle");
      setDouyinFeedback({
        message: savedSettings.cookie
          ? "访问凭证验证成功并已保存。"
          : "抖音账号访问凭证已清除。",
        tone: "success",
      });
    } catch (saveError) {
      setDouyinFeedback({
        message: readUserFacingError(saveError, "抖音账号凭证保存失败。"),
        tone: "error",
      });
    } finally {
      setIsDouyinSaving(false);
    }
  }

  async function saveBilibiliSettings(nextSettings: BilibiliSettings = bilibiliSettings) {
    setIsBilibiliSaving(true);
    setBilibiliFeedback(undefined);
    try {
      const response = await fetch("/api/user/settings", {
        body: JSON.stringify({ category: "bilibili", value: nextSettings }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await readJsonPayload(response, "Bilibili 账号凭证保存失败。") as UserSettingsPayload;
      if (!response.ok) {
        const apiError = getApiError(payload);
        setBilibiliCredentialStatus(
          apiError?.code === "LOGIN_REQUIRED" || apiError?.code === "INVALID_COOKIE"
            ? "invalid"
            : "unavailable",
        );
        throw new Error(apiError?.error || "Bilibili 账号凭证保存失败。");
      }
      const savedSettings = normalizeBilibiliSettings(payload.settings?.bilibili);
      setBilibiliSettings(savedSettings);
      setBilibiliCredentialStatus(savedSettings.cookie ? "valid" : "idle");
      setBilibiliFeedback({
        message: savedSettings.cookie
          ? "Bilibili 凭证已验证并保存。"
          : "Bilibili 访问凭证已清除。",
        tone: "success",
      });
    } catch (saveError) {
      setBilibiliFeedback({
        message: readUserFacingError(saveError, "Bilibili 账号凭证保存失败。"),
        tone: "error",
      });
    } finally {
      setIsBilibiliSaving(false);
    }
  }

  async function generateBilibiliQrCode() {
    setIsBilibiliQrLoading(true);
    setBilibiliQrSession(undefined);
    setBilibiliFeedback(undefined);
    try {
      const response = await fetch("/api/bilibili/credential/qrcode", { method: "POST" });
      const payload = await readJsonPayload(response, "Bilibili 登录二维码生成失败。") as BilibiliQrSession;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "Bilibili 登录二维码生成失败。");
      }
      setBilibiliQrSession(payload);
      setBilibiliFeedback({ message: "请使用 Bilibili App 扫码并确认登录。", tone: "warning" });
    } catch (error) {
      setBilibiliFeedback({ message: readUserFacingError(error, "Bilibili 登录二维码生成失败。"), tone: "error" });
    } finally {
      setIsBilibiliQrLoading(false);
    }
  }

  async function pollBilibiliQrCode(session: BilibiliQrSession) {
    if (isBilibiliQrPolling) return;
    setIsBilibiliQrPolling(true);
    setBilibiliFeedback(undefined);
    try {
      const response = await fetch("/api/bilibili/credential/qrcode/poll", {
        body: JSON.stringify({ qrcodeKey: session.qrcodeKey }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJsonPayload(response, "Bilibili 登录状态检测失败。") as BilibiliQrPollPayload;
      if (!response.ok) {
        throw new Error(getApiError(payload)?.error || "Bilibili 登录状态检测失败。");
      }
      if (payload.status === "confirmed") {
        const savedSettings = normalizeBilibiliSettings(payload.state);
        setBilibiliSettings(savedSettings);
        setBilibiliCredentialStatus("valid");
        setBilibiliQrSession(undefined);
        setBilibiliFeedback({
          message: "Bilibili 凭证已验证并保存。",
          tone: "success",
        });
        return;
      }
      if (payload.status === "expired") {
        setBilibiliQrSession(undefined);
        setBilibiliFeedback({ message: payload.message || "二维码已过期，请重新生成。", tone: "error" });
        return;
      }
      setBilibiliFeedback({ message: payload.message || "等待扫码确认。", tone: "warning" });
    } catch (error) {
      setBilibiliFeedback({ message: readUserFacingError(error, "Bilibili 登录状态检测失败。"), tone: "error" });
    } finally {
      setIsBilibiliQrPolling(false);
    }
  }

  const windowsArtifact = windowsArchitecture
    ? credentialHelperArtifacts.windows[windowsArchitecture]
    : null;
  const automaticDownload = detectedPlatform === "windows" && windowsArtifact
    ? {
        label: windowsArtifact.label,
        url: `/downloads/${windowsArtifact.fileName}`,
      }
    : null;

  const credentialStatusIndicator = {
    idle: { label: "尚未验证", style: "bg-black/35" },
    invalid: { label: "凭证无效", style: "bg-rose-500" },
    unavailable: { label: "检测失败", style: "bg-amber" },
    valid: { label: "凭证有效", style: "bg-emerald-500" },
  }[credentialStatus];
  const bilibiliCredentialStatusIndicator = {
    idle: { label: "尚未验证", style: "bg-black/35" },
    invalid: { label: "凭证无效", style: "bg-rose-500" },
    unavailable: { label: "检测失败", style: "bg-amber" },
    valid: { label: "凭证有效", style: "bg-emerald-500" },
  }[bilibiliCredentialStatus];

  return (
    <main className="min-h-dvh w-full bg-background text-foreground">
      <div className="flex min-h-dvh w-full flex-col">
        <header className="flex min-h-16 w-full items-center border-b border-white/10 px-4 sm:px-6 md:px-4 lg:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground active:bg-white/[0.1]"
              aria-label="返回首页"
              title="返回首页"
            >
              <ArrowLeft className="size-5" strokeWidth={2} aria-hidden="true" />
            </Link>
            <h1 className="truncate text-xl font-semibold text-foreground">设置</h1>
          </div>
        </header>

        <div className="grid flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1">
          <aside className="border-b border-white/10 px-4 py-4 sm:px-6 md:border-b-0 md:border-r md:px-4 lg:px-5">
            <nav className="grid gap-1" aria-label="设置导航">
              <button
                type="button"
                onClick={() => setActiveSection("aiCredential")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors ${activeSection === "aiCredential" ? "bg-cyan/[0.1] text-cyan" : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"}`}
                aria-current={activeSection === "aiCredential" ? "page" : undefined}
              >
                <KeyRound className="size-4" aria-hidden="true" />
                自定义 APIKey
              </button>
              <button
                type="button"
                onClick={() => setActiveSection("apiTokens")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors ${activeSection === "apiTokens" ? "bg-cyan/[0.1] text-cyan" : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"}`}
                aria-current={activeSection === "apiTokens" ? "page" : undefined}
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                API 访问令牌
              </button>
              <button
                type="button"
                onClick={() => setActiveSection("douyin")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors ${activeSection === "douyin" ? "bg-cyan/[0.1] text-cyan" : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"}`}
                aria-current={activeSection === "douyin" ? "page" : undefined}
              >
                <UserRound className="size-4" aria-hidden="true" />
                账号凭证
              </button>
              <button
                type="button"
                onClick={() => setActiveSection("download")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors ${activeSection === "download" ? "bg-cyan/[0.1] text-cyan" : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"}`}
                aria-current={activeSection === "download" ? "page" : undefined}
              >
                <Download className="size-4" aria-hidden="true" />
                下载配置
              </button>
            </nav>
          </aside>

          <section className="min-w-0 px-4 py-4 sm:px-5 lg:px-6">
            {activeSection === "aiCredential" ? (
               <AiCredentialPanel
                 apiKey={aiCredentialApiKey}
                 configured={aiCredentialConfigured}
                 isLoaded={isLoaded}
                 models={aiModels}
                 onGuideOpen={() => {
                   setApiGuideZoom(1);
                   setIsApiGuideOpen(true);
                 }}
                 onApiKeyChange={setAiCredentialApiKey}
                 onConfiguredChange={setAiCredentialConfigured}
                 onModelsChange={setAiModels}
               />
            ) : activeSection === "apiTokens" ? (
              <ApiTokensPanel isLoaded={isLoaded} />
            ) : activeSection === "douyin" ? (
              <div className="w-full max-w-2xl">
              <div className="mb-4 border-b border-white/10 pb-3">
                <h2 className="text-base font-semibold text-foreground">账号凭证</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  用于在 EchoLens 中使用需要平台登录状态的相关功能，请妥善保管避免泄露。
                </p>
              </div>

              <div className="mb-3">
                <PlatformCredentialHeading
                  icon={<DouyinIcon className="size-5" />}
                  title="抖音凭证"
                />
              </div>

              <div
                className="mb-3 grid grid-cols-2 rounded-md bg-white/[0.045] p-0.5"
                role="group"
                aria-label="凭证获取方式"
              >
                <button
                  type="button"
                  aria-pressed={credentialMethod === "automatic"}
                  onClick={() => setCredentialMethod("automatic")}
                  className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                    credentialMethod === "automatic"
                      ? "bg-surface-strong text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <MonitorDown className="size-3.5 text-cyan" aria-hidden="true" />
                  自动获取
                </button>
                <button
                  type="button"
                  aria-pressed={credentialMethod === "manual"}
                  onClick={() => setCredentialMethod("manual")}
                  className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                    credentialMethod === "manual"
                      ? "bg-surface-strong text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <SquareTerminal className="size-3.5 text-amber" aria-hidden="true" />
                  开发者工具
                </button>
              </div>

              <div className="rounded-md border border-white/10 bg-white/[0.025] p-3 sm:p-4">
                {credentialMethod === "automatic" ? (
                  <div className="grid gap-3">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h3 className="text-xs font-semibold text-foreground">使用自动获取程序（推荐）</h3>
                        {automaticDownload ? (
                          <details className="relative">
                            <summary
                              className="inline-flex size-6 cursor-pointer list-none items-center justify-center text-muted-foreground transition-colors hover:text-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan/30 [&::-webkit-details-marker]:hidden"
                              aria-label="查看 Windows 首次运行提示"
                              title="Windows 首次运行提示"
                            >
                              <CircleHelp className="size-4" aria-hidden="true" />
                            </summary>
                            <div className="absolute left-1/2 top-7 z-20 w-[min(19rem,calc(100vw-3rem))] -translate-x-1/2 rounded-md border border-white/15 bg-surface-strong p-3 text-xs font-normal leading-5 text-muted-foreground shadow-xl shadow-black/30">
                              <p className="font-semibold text-foreground">Windows 首次运行提示</p>
                              <p className="mt-1">
                                如果看到“Windows 已保护你的电脑”，且发布者显示“未知发布者”，请点击“更多信息”，确认应用名称以 EchoLens-Helper 开头，再点击“仍要运行”。
                              </p>
                            </div>
                          </details>
                        ) : null}
                      </div>
                      {detectedPlatform === "windows" || detectedPlatform === undefined ? (
                        <ul className="mt-2 grid gap-1.5 text-xs leading-5 text-muted-foreground">
                          <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                            <span className="font-medium text-amber">需要你</span>
                            <span>下载并运行程序，确认 Windows 的打开提示。</span>
                          </li>
                          <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                            <span className="font-medium text-amber">需要你</span>
                            <span>在独立浏览器窗口中完成抖音登录。</span>
                          </li>
                          <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                            <span className="font-medium text-cyan">自动完成</span>
                            <span>检测登录状态，提取完整凭证并复制到剪贴板。</span>
                          </li>
                          <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                            <span className="font-medium text-cyan">自动完成</span>
                            <span>关闭临时浏览器、清理临时数据并返回本设置页。</span>
                          </li>
                          <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
                            <span className="font-medium text-amber">需要你</span>
                            <span>将剪贴板中的凭证粘贴到下方输入框，然后保存。</span>
                          </li>
                        </ul>
                      ) : null}
                    </div>
                    {automaticDownload ? (
                      <a
                        href={automaticDownload.url}
                        download
                        className="inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98]"
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        {automaticDownload.label}
                      </a>
                    ) : detectedPlatform === undefined || detectedPlatform === "windows" ? (
                      <button
                        type="button"
                        disabled
                        className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-muted px-3 text-xs font-semibold text-muted-foreground"
                      >
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        正在检测系统
                      </button>
                    ) : detectedPlatform === "macos" ? (
                      <p className="text-xs leading-5 text-amber">
                        macOS 版本需要在 Mac 上完成签名与验证，当前请使用开发者工具方式。
                      </p>
                    ) : (
                      <p className="text-xs leading-5 text-amber">
                        自动获取仅面向 Windows 和 macOS，当前系统请使用开发者工具方式。
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-3">
                    <div>
                      <h3 className="text-xs font-semibold text-foreground">通过开发者工具获取</h3>
                      <ol className="sr-only">
                        <li>在浏览器中登录任意抖音页面。</li>
                        <li>打开开发者工具：Windows 按 <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-xs text-foreground">F12</kbd>，macOS 按 <kbd className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-xs text-foreground">Option + Command + I</kbd>。</li>
                        <li>点击顶部的 <code className="font-mono text-xs text-cyan">Network</code>。</li>
                        <li>点击漏斗形筛选按钮，显示筛选框。</li>
                        <li>粘贴 <code className="font-mono text-xs text-cyan">domain:www.douyin.com resource-type:document</code>，然后刷新页面。</li>
                        <li>在列表中点击唯一的 <code className="font-mono text-xs text-cyan">www.douyin.com</code> 主页面请求。</li>
                        <li>打开 <code className="font-mono text-xs text-cyan">Headers</code> &gt; <code className="font-mono text-xs text-cyan">Request Headers</code>，找到 <code className="font-mono text-xs text-cyan">Cookie</code>，只复制冒号后的内容并粘贴到下方输入框。</li>
                      </ol>
                      <button
                        type="button"
                        onClick={() => {
                          setGuideZoom(1);
                          setIsGuideOpen(true);
                        }}
                        className="group relative mt-2 block w-full overflow-hidden rounded-md border border-white/10 bg-black/25 text-left outline-none transition hover:border-cyan/45 focus-visible:border-cyan/60 focus-visible:ring-2 focus-visible:ring-cyan/20"
                        aria-label="放大查看通过开发者工具获取访问凭证的操作流程图"
                        title="放大查看操作流程图"
                      >
                        <Image
                          src="/douyin-credential-guide.png"
                          alt="通过开发者工具获取抖音访问凭证的七步操作流程图"
                          width={1586}
                          height={992}
                          className="h-auto w-full"
                          priority={false}
                        />
                        <span className="absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md border border-white/15 bg-black/70 text-white backdrop-blur-sm transition group-hover:border-cyan/50 group-hover:text-cyan">
                          <Maximize2 className="size-4" aria-hidden="true" />
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4">
                <div className="flex min-h-8 items-center">
                  <label htmlFor="douyin-credential" className="text-xs font-semibold text-foreground">
                    抖音访问凭证
                  </label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input
                      id="douyin-credential"
                      type={isCredentialVisible ? "text" : "password"}
                      value={settings.cookie}
                      onChange={(event) => {
                        setSettings({ ...settings, cookie: event.target.value });
                        setCredentialStatus("idle");
                        setDouyinFeedback(undefined);
                      }}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-9 w-full rounded-md border border-cyan/40 bg-black/25 py-1.5 pl-3 pr-[4.5rem] font-mono text-xs text-foreground outline-none transition placeholder:font-sans placeholder:text-muted-foreground/65 hover:border-cyan/55 focus:border-cyan/70 focus:ring-2 focus:ring-cyan/15"
                      placeholder="粘贴完整 Cookie"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSettings((current) => ({ ...current, cookie: "" }));
                        setCredentialStatus("idle");
                        setDouyinFeedback(undefined);
                      }}
                      disabled={!settings.cookie || isDouyinSaving}
                      className="absolute inset-y-0 right-9 inline-flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-35"
                      aria-label="清空访问凭证"
                      title="清空访问凭证"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsCredentialVisible((current) => !current)}
                      className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={isCredentialVisible ? "隐藏访问凭证" : "显示访问凭证"}
                      title={isCredentialVisible ? "隐藏访问凭证" : "显示访问凭证"}
                    >
                      {isCredentialVisible ? (
                        <EyeOff className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Eye className="size-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveSettings()}
                    disabled={isDouyinSaving || !isLoaded}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <span
                      className={`mr-1.5 size-2 rounded-full ${isDouyinSaving ? "bg-cyan" : credentialStatusIndicator.style}`}
                      role="status"
                      aria-label={isDouyinSaving ? "正在验证并保存" : credentialStatusIndicator.label}
                    />
                    {isDouyinSaving ? "验证中" : "验证并保存"}
                  </button>
                </div>
                <FeedbackMessage feedback={douyinFeedback} feedbackRef={douyinFeedbackRef} />
              </div>
              <div className="mt-5 border-t border-white/10 pt-4">
                <div className="flex min-h-8 items-start justify-between gap-3">
                  <div>
                    <PlatformCredentialHeading
                      icon={<BilibiliIcon className="size-5" />}
                      title="Bilibili 凭证"
                    />
                  </div>
                </div>
                <div className="mt-3 rounded-md border border-white/10 bg-white/[0.025] p-3">
                  <div
                    className="grid grid-cols-2 rounded-md bg-white/[0.045] p-0.5"
                    role="group"
                    aria-label="Bilibili 凭证获取方式"
                  >
                    <button
                      type="button"
                      aria-pressed={bilibiliCredentialMethod === "automatic"}
                      onClick={() => setBilibiliCredentialMethod("automatic")}
                      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                        bilibiliCredentialMethod === "automatic"
                          ? "bg-surface-strong text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <MonitorDown className="size-3.5 text-cyan" aria-hidden="true" />
                      自动获取
                    </button>
                    <button
                      type="button"
                      aria-pressed={bilibiliCredentialMethod === "manual"}
                      onClick={() => {
                        setBilibiliCredentialMethod("manual");
                        setBilibiliQrSession(undefined);
                        setBilibiliFeedback(undefined);
                      }}
                      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
                        bilibiliCredentialMethod === "manual"
                          ? "bg-surface-strong text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <SquareTerminal className="size-3.5 text-amber" aria-hidden="true" />
                      开发者工具
                    </button>
                  </div>
                  {bilibiliCredentialMethod === "automatic" ? (
                    <div className="mt-3 grid gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void generateBilibiliQrCode()}
                          disabled={!isLoaded || isBilibiliQrLoading || isBilibiliQrPolling}
                          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-white/[0.06] px-3 text-xs font-semibold text-cyan transition hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:text-muted-foreground"
                        >
                          {isBilibiliQrLoading ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <MonitorDown className="size-3.5" aria-hidden="true" />}
                          生成 Bilibili 扫码登录
                        </button>
                        <span className="text-xs leading-5 text-muted-foreground">
                          使用 Bilibili App 扫码并确认后，点击“立即检测”保存 Cookie。
                        </span>
                      </div>
                      {bilibiliQrSession ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <div
                            className="rounded-md bg-white p-2"
                            aria-label="Bilibili 登录二维码"
                            dangerouslySetInnerHTML={{ __html: bilibiliQrSession.svg }}
                          />
                          <div className="grid gap-2 text-xs leading-5 text-muted-foreground">
                            <button
                              type="button"
                              onClick={() => void pollBilibiliQrCode(bilibiliQrSession)}
                              disabled={isBilibiliQrPolling}
                              className="inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-md bg-cyan px-3 font-semibold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                            >
                              {isBilibiliQrPolling ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-3.5" aria-hidden="true" />}
                              立即检测
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <ol className="mt-3 grid list-decimal gap-1 pl-4 text-xs leading-5 text-muted-foreground">
                      <li>登录 Bilibili 网页端后打开开发者工具 Network。</li>
                      <li>刷新任意 Bilibili 页面，选中主文档请求，在 Request Headers 中复制 Cookie。</li>
                      <li>至少需要包含 <code className="text-cyan">SESSDATA</code>；系统会用 nav 接口检测真实登录态。</li>
                    </ol>
                  )}
                </div>
                <label htmlFor="bilibili-credential" className="sr-only">
                  Bilibili 访问凭证
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input
                      id="bilibili-credential"
                      type={isCredentialVisible ? "text" : "password"}
                      value={bilibiliSettings.cookie}
                      onChange={(event) => {
                        setBilibiliSettings({ ...bilibiliSettings, cookie: event.target.value });
                        setBilibiliCredentialStatus("idle");
                        setBilibiliFeedback(undefined);
                      }}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="h-9 w-full rounded-md border border-cyan/40 bg-black/25 py-1.5 pl-3 pr-[4.5rem] font-mono text-xs text-foreground outline-none transition placeholder:font-sans placeholder:text-muted-foreground/65 hover:border-cyan/55 focus:border-cyan/70 focus:ring-2 focus:ring-cyan/15"
                      placeholder="粘贴 SESSDATA、bili_jct、DedeUserID 等 Cookie"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setBilibiliSettings({ cookie: "" });
                        setBilibiliCredentialStatus("idle");
                        setBilibiliFeedback(undefined);
                      }}
                      disabled={!bilibiliSettings.cookie || isBilibiliSaving}
                      className="absolute inset-y-0 right-9 inline-flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-35"
                      aria-label="清空 Bilibili 访问凭证"
                      title="清空 Bilibili 访问凭证"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsCredentialVisible((current) => !current)}
                      className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={isCredentialVisible ? "隐藏访问凭证" : "显示访问凭证"}
                      title={isCredentialVisible ? "隐藏访问凭证" : "显示访问凭证"}
                    >
                      {isCredentialVisible ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveBilibiliSettings()}
                    disabled={isBilibiliSaving || !isLoaded}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <span
                      className={`mr-1.5 size-2 rounded-full ${isBilibiliSaving ? "bg-cyan" : bilibiliCredentialStatusIndicator.style}`}
                      role="status"
                      aria-label={isBilibiliSaving ? "正在验证并保存" : bilibiliCredentialStatusIndicator.label}
                    />
                    {isBilibiliSaving ? "验证中" : "验证并保存"}
                  </button>
                </div>
                <FeedbackMessage feedback={bilibiliFeedback} feedbackRef={bilibiliFeedbackRef} />
              </div>
              </div>
            ) : (
              <DownloadSettingsPanel
                isLoaded={isLoaded}
                settings={downloadSettings}
                onSettingsChange={setDownloadSettings}
              />
            )}
          </section>
        </div>
      </div>
      <GuideImageModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
        onZoomChange={setGuideZoom}
        src="/douyin-credential-guide.png"
        alt="通过开发者工具获取抖音访问凭证的七步操作流程图放大视图"
        ariaLabel="通过开发者工具获取访问凭证操作流程图"
        title="操作流程图"
        width={1586}
        height={992}
        zoom={guideZoom}
      />
      <GuideImageModal
        isOpen={isApiGuideOpen}
        onClose={() => setIsApiGuideOpen(false)}
        onZoomChange={setApiGuideZoom}
        src="/dashscope-api-key-guide.png"
        alt="EchoLens 新加坡地域 API Key 创建流程图放大视图"
        ariaLabel="创建正确 API Key 操作流程图"
        title="创建 API Key 流程图"
        width={1680}
        height={942}
        zoom={apiGuideZoom}
      />
    </main>
  );
}
