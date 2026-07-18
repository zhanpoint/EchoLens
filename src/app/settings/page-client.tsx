"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CircleHelp,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Maximize2,
  MonitorDown,
  RotateCcw,
  SquareTerminal,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  DEFAULT_DOWNLOAD_ORGANIZATION,
  isDownloadOrganization,
  type DownloadOrganization,
} from "@/lib/download-settings";
import { getApiError, readJsonPayload, readUserFacingError } from "../douyin/_client-api";

type DouyinSettings = {
  credentialStatus?: "invalid" | "missing" | "unknown" | "valid";
  cookie: string;
};

type UserSettingsPayload = {
  settings?: {
    douyin?: Partial<DouyinSettings>;
    download?: Partial<DownloadSettings>;
  };
};

type DownloadSettings = {
  directoryPath: string;
  organization: DownloadOrganization;
};

type CredentialStatus = "idle" | "valid" | "invalid" | "unavailable";

type Feedback = {
  message: string;
  tone: "success" | "warning" | "error";
};

function normalizeDouyinSettings(value: Partial<DouyinSettings> | undefined): DouyinSettings {
  return {
    credentialStatus: value?.credentialStatus,
    cookie: typeof value?.cookie === "string" ? value.cookie : "",
  };
}

function normalizeDownloadSettings(value: Partial<DownloadSettings> | undefined): DownloadSettings {
  const organization = value?.organization;
  return {
    directoryPath: typeof value?.directoryPath === "string" ? value.directoryPath : "",
    organization: isDownloadOrganization(organization) ? organization : DEFAULT_DOWNLOAD_ORGANIZATION,
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
  const [isSaving, setIsSaving] = useState(false);
  const helpDetailsRef = useRef<HTMLDetailsElement>(null);
  const directoryPickerSupported = supportsDownloadDirectoryPicker();
  const selectedOrganization = DOWNLOAD_ORGANIZATION_OPTIONS.find((option) => option.value === settings.organization)
    ?? DOWNLOAD_ORGANIZATION_OPTIONS[0];

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
                <span className="ml-auto truncate font-semibold text-foreground">{selectedOrganization.label}</span>
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
                    <span className="text-sm font-semibold text-foreground">{option.label}</span>
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
      {feedback ? (
        <p className="mt-2 text-xs font-medium leading-5 text-rose-400" role="alert">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<"douyin" | "download">("douyin");
  const [credentialMethod, setCredentialMethod] = useState<"automatic" | "manual">("automatic");
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus>("idle");
  const [feedback, setFeedback] = useState<Feedback>();
  const [guideZoom, setGuideZoom] = useState(1);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [windowsArchitecture, setWindowsArchitecture] = useState<WindowsArchitecture>();
  const detectedPlatform = useSyncExternalStore(
    subscribeToPlatform,
    detectSupportedPlatform,
    () => undefined,
  );
  const [settings, setSettings] = useState<DouyinSettings>({ cookie: "" });
  const [downloadSettings, setDownloadSettings] = useState<DownloadSettings>({
    directoryPath: "",
    organization: DEFAULT_DOWNLOAD_ORGANIZATION,
  });
  const [isCredentialVisible, setIsCredentialVisible] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [feedback]);

  useEffect(() => {
    if (!isGuideOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsGuideOpen(false);
      } else if (event.key === "+" || event.key === "=") {
        setGuideZoom((current) => Math.min(3, current + 0.25));
      } else if (event.key === "-") {
        setGuideZoom((current) => Math.max(0.5, current - 0.25));
      } else if (event.key === "0") {
        setGuideZoom(1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isGuideOpen]);

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

        const settingsResponse = await fetch("/api/user/settings", { cache: "no-store" });
        const settingsPayload = await readJsonPayload(settingsResponse, "设置加载失败。") as UserSettingsPayload;
        if (!settingsResponse.ok) {
          throw new Error(getApiError(settingsPayload)?.error || "设置加载失败。");
        }

        if (isActive) {
          const loadedSettings = normalizeDouyinSettings(settingsPayload.settings?.douyin);
          const loadedDownloadSettings = normalizeDownloadSettings(settingsPayload.settings?.download);
          setSettings(loadedSettings);
          setDownloadSettings(loadedDownloadSettings);
          cacheDownloadOrganization(loadedDownloadSettings.organization);
          setCredentialStatus(
            loadedSettings.credentialStatus === "valid"
              ? "valid"
              : loadedSettings.credentialStatus === "invalid"
                ? "invalid"
                : "idle",
          );
          setIsLoaded(true);
        }
      } catch (loadError) {
        if (isActive) {
          setFeedback({
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
    setIsSaving(true);
    setFeedback(undefined);
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
      setFeedback({
        message: savedSettings.cookie
          ? "访问凭证验证成功并已保存。"
          : "抖音账号访问凭证已清除。",
        tone: "success",
      });
    } catch (saveError) {
      setFeedback({
        message: readUserFacingError(saveError, "抖音账号凭证保存失败。"),
        tone: "error",
      });
    } finally {
      setIsSaving(false);
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
                onClick={() => setActiveSection("douyin")}
                className={`flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-semibold transition-colors ${activeSection === "douyin" ? "bg-cyan/[0.1] text-cyan" : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"}`}
                aria-current={activeSection === "douyin" ? "page" : undefined}
              >
                <UserRound className="size-4" aria-hidden="true" />
                抖音账号凭证
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
            {activeSection === "douyin" ? (
              <div className="w-full max-w-2xl">
              <div className="mb-4 border-b border-white/10 pb-3">
                <h2 className="text-base font-semibold text-foreground">抖音账号凭证</h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  用于在 EchoLens 中使用需要抖音登录状态的相关功能，请妥善保管避免泄露。
                </p>
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
                        <h3 className="text-sm font-semibold text-foreground">使用自动获取程序（推荐）</h3>
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
                      <h3 className="text-sm font-semibold text-foreground">通过开发者工具获取</h3>
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

              <div className="mt-4 border-t border-white/10 pt-4">
                <div className="flex min-h-8 items-center">
                  <label htmlFor="douyin-credential" className="text-xs font-semibold text-foreground">
                    访问凭证
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
                        setFeedback(undefined);
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
                        setFeedback(undefined);
                      }}
                      disabled={!settings.cookie || isSaving}
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
                    disabled={isSaving || !isLoaded}
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-cyan px-3 text-xs font-semibold text-black transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  >
                    <span
                      className={`mr-1.5 size-2 rounded-full ${isSaving ? "animate-pulse bg-cyan" : credentialStatusIndicator.style}`}
                      role="status"
                      aria-label={isSaving ? "正在验证并保存" : credentialStatusIndicator.label}
                    />
                    {isSaving ? "验证中" : "验证并保存"}
                  </button>
                </div>
                {feedback ? (
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
                ) : null}
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
      {isGuideOpen ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/95"
          role="dialog"
          aria-modal="true"
          aria-label="通过开发者工具获取访问凭证操作流程图"
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-black px-3 sm:px-4">
            <span className="truncate text-sm font-semibold text-white">操作流程图</span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setGuideZoom((current) => Math.max(0.5, current - 0.25))}
                disabled={guideZoom <= 0.5}
                className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="缩小图片"
                title="缩小"
              >
                <ZoomOut className="size-4" aria-hidden="true" />
              </button>
              <span className="w-12 text-center text-xs tabular-nums text-white/70">
                {Math.round(guideZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setGuideZoom((current) => Math.min(3, current + 0.25))}
                disabled={guideZoom >= 3}
                className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                aria-label="放大图片"
                title="放大"
              >
                <ZoomIn className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setGuideZoom(1)}
                className="inline-flex size-8 items-center justify-center rounded-md text-white/75 transition hover:bg-white/10 hover:text-white"
                aria-label="重置图片大小"
                title="重置"
              >
                <RotateCcw className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setIsGuideOpen(false)}
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
              <div
                className="shrink-0 transition-[width] duration-150"
                style={{ width: `${guideZoom * 100}%` }}
              >
                <Image
                  src="/douyin-credential-guide.png"
                  alt="通过开发者工具获取抖音访问凭证的七步操作流程图放大视图"
                  width={1586}
                  height={992}
                  className="h-auto w-full"
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
