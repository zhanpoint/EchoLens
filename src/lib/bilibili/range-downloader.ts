import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const SEQUENTIAL_TIMEOUT_MS = 600_000;

type SourceProbe = {
  contentType: string;
  rangeSupported: boolean;
  sizeBytes?: number;
  urls: string[];
};

export type DownloadedFile = {
  cleanup: () => Promise<void>;
  contentType: string;
  filePath: string;
  sizeBytes: number;
};

export async function downloadBilibiliStream(input: {
  headers: Readonly<Record<string, string>>;
  name: string;
  urls: readonly string[];
}): Promise<DownloadedFile> {
  const directory = await mkdtemp(join(tmpdir(), "echolens-bilibili-"));
  const filePath = join(directory, input.name);
  try {
    const source = await probeSource(input.urls, input.headers);
    if (source.sizeBytes !== undefined && source.rangeSupported) {
      await downloadRanges({ filePath, headers: input.headers, sizeBytes: source.sizeBytes, urls: source.urls });
    } else {
      await downloadSequential(source.urls, filePath, input.headers);
    }
    const sizeBytes = (await stat(filePath)).size;
    if (!sizeBytes) throw new Error("Bilibili 媒体流为空。");
    return {
      cleanup: () => rm(directory, { force: true, recursive: true }),
      contentType: source.contentType,
      filePath,
      sizeBytes,
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function probeSource(
  urls: readonly string[],
  headers: Readonly<Record<string, string>>,
): Promise<SourceProbe> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const head = await probeHead(url, headers);
      if (head) return { ...head, urls: prioritizeUrl(urls, url) };
      const range = await probeRange(url, headers);
      if (range) return { ...range, urls: prioritizeUrl(urls, url) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Bilibili CDN 不可用：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

async function probeHead(url: string, headers: Readonly<Record<string, string>>): Promise<Omit<SourceProbe, "urls"> | null> {
  const response = await fetch(url, {
    headers,
    method: "HEAD",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  if (response.status !== 200) return null;
  const sizeBytes = readPositiveInteger(response.headers.get("content-length"));
  return {
    contentType: response.headers.get("content-type") || "application/octet-stream",
    rangeSupported: response.headers.get("accept-ranges")?.toLowerCase() === "bytes" && sizeBytes !== undefined,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

async function probeRange(url: string, headers: Readonly<Record<string, string>>): Promise<Omit<SourceProbe, "urls"> | null> {
  const response = await fetch(url, {
    headers: { ...headers, range: "bytes=0-0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const contentRange = response.headers.get("content-range");
  const sizeBytes = readPositiveInteger(contentRange?.match(/\/(\d+)$/u)?.[1] ?? response.headers.get("content-length"));
  const rangeSupported = response.status === 206 && Boolean(contentRange);
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  await response.body?.cancel();
  if (response.ok && sizeBytes !== undefined) return { contentType, rangeSupported, sizeBytes };
  if (response.ok) return { contentType, rangeSupported: false };
  return null;
}

async function downloadRanges(input: {
  filePath: string;
  headers: Readonly<Record<string, string>>;
  sizeBytes: number;
  urls: readonly string[];
}): Promise<void> {
  const file = await open(input.filePath, "w+");
  const count = Math.ceil(input.sizeBytes / DEFAULT_CHUNK_SIZE);
  let nextIndex = 0;
  try {
    await file.truncate(input.sizeBytes);
    await Promise.all(Array.from({ length: Math.min(DEFAULT_CONCURRENCY, count) }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= count) return;
        const start = index * DEFAULT_CHUNK_SIZE;
        const end = Math.min(input.sizeBytes - 1, start + DEFAULT_CHUNK_SIZE - 1);
        await writeRange({ end, file, headers: input.headers, start, urls: input.urls });
      }
    }));
  } finally {
    await file.close();
  }
}

async function writeRange(input: {
  end: number;
  file: Awaited<ReturnType<typeof open>>;
  headers: Readonly<Record<string, string>>;
  start: number;
  urls: readonly string[];
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    for (const url of input.urls) {
      try {
        await streamRange(url, input);
        return;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(`Bilibili 分片下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

async function streamRange(
  url: string,
  input: Omit<Parameters<typeof writeRange>[0], "urls">,
): Promise<void> {
  const expectedSize = input.end - input.start + 1;
  const response = await fetch(url, {
    headers: { ...input.headers, range: `bytes=${input.start}-${input.end}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }

  let offset = input.start;
  let downloaded = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      await input.file.write(value, 0, value.byteLength, offset);
      offset += value.byteLength;
      downloaded += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (downloaded !== expectedSize) {
    throw new Error(`Chunk mismatch (Expected: ${expectedSize}, Got: ${downloaded})`);
  }
}

async function downloadSequential(
  urls: readonly string[],
  filePath: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(SEQUENTIAL_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
        createWriteStream(filePath),
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Bilibili 媒体下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

function readPositiveInteger(value: string | null | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function prioritizeUrl(urls: readonly string[], selected: string): string[] {
  return [selected, ...urls.filter((url) => url !== selected)];
}