import {
  buildDirectorySegments,
  DEFAULT_DOWNLOAD_ORGANIZATION,
  isDownloadOrganization,
  sanitizeDownloadPathSegment,
  type DownloadOrganization,
} from "@/lib/download-settings";

export type { DownloadOrganization } from "@/lib/download-settings";

export type DownloadContext = {
  authorName?: string;
  contentType?: string;
  workId?: string;
  workTitle?: string;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};

const DATABASE_NAME = "echolens-browser-storage";
const DATABASE_VERSION = 1;
const DIRECTORY_HANDLE_KEY = "download-directory";
const OBJECT_STORE_NAME = "handles";
let downloadOrganizationCache: DownloadOrganization | undefined;

export function supportsDownloadDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

export async function chooseDownloadDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("当前浏览器不支持自定义下载目录，请使用最新版 Chrome 或 Edge。");
  }
  const handle = await picker({ id: "echolens-downloads", mode: "readwrite" });
  await storeDirectoryHandle(handle);
  return handle;
}

export async function readDownloadDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(OBJECT_STORE_NAME, "readonly").objectStore(OBJECT_STORE_NAME).get(DIRECTORY_HANDLE_KEY);
      request.onsuccess = () => {
        const result = request.result as Partial<FileSystemDirectoryHandle> | undefined;
        resolve(result?.kind === "directory" && typeof result.getFileHandle === "function"
          ? result as FileSystemDirectoryHandle
          : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export function cacheDownloadOrganization(organization: DownloadOrganization): void {
  downloadOrganizationCache = organization;
}

export async function saveToDownloadDirectory(
  sourceUrl: string,
  filename: string,
  context: DownloadContext = {},
): Promise<boolean> {
  const root = await readDownloadDirectory().catch(() => null);
  if (!root) {
    return false;
  }

  const permissionHandle = root as PermissionCapableDirectoryHandle;
  let permission = await permissionHandle.queryPermission({ mode: "readwrite" });
  if (permission === "prompt") {
    permission = await permissionHandle.requestPermission({ mode: "readwrite" });
  }
  if (permission !== "granted") {
    return false;
  }

  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  const directory = await resolveTargetDirectory(root, await readDownloadOrganization(), {
    ...context,
    contentType: context.contentType || response.headers.get("content-type") || undefined,
  }, filename);
  const fileHandle = await directory.getFileHandle(sanitizeDownloadPathSegment(filename, "download"), { create: true });
  const writable = await fileHandle.createWritable();
  await response.body.pipeTo(writable);
  return true;
}

async function readDownloadOrganization(): Promise<DownloadOrganization> {
  if (downloadOrganizationCache) {
    return downloadOrganizationCache;
  }
  try {
    const response = await fetch("/api/user/settings", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json() as { settings?: { download?: { organization?: unknown } } };
      if (isDownloadOrganization(payload.settings?.download?.organization)) {
        downloadOrganizationCache = payload.settings.download.organization;
        return downloadOrganizationCache;
      }
    }
  } catch {
    // The default keeps downloads usable if settings cannot be loaded temporarily.
  }
  return DEFAULT_DOWNLOAD_ORGANIZATION;
}

async function resolveTargetDirectory(
  root: FileSystemDirectoryHandle,
  organization: DownloadOrganization,
  context: DownloadContext,
  filename: string,
): Promise<FileSystemDirectoryHandle> {
  const segments = buildDirectorySegments(organization, context, filename);
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  try {
    await completeRequest(database.transaction(OBJECT_STORE_NAME, "readwrite").objectStore(OBJECT_STORE_NAME).put(handle, DIRECTORY_HANDLE_KEY));
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        request.result.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completeRequest(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
