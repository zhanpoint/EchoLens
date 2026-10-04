import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const SEQUENTIAL_TIMEOUT_MS = 600_000;

class MediaFileWriteError extends Error {}
class MediaInputLimitError extends Error {}
class MediaRangeUnsupportedError extends Error {}

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

export async function downloadMediaFile(input: {
  headers: Readonly<Record<string, string>>;
  maxBytes?: number;
  name: string;
  signal?: AbortSignal;
  urls: readonly string[];
}): Promise<DownloadedFile> {
  input.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "echolens-media-"));
  const filePath = join(directory, input.name);
  try {
    const source = await probeSource(input.urls, input.headers, input.signal);
    if (input.maxBytes !== undefined && source.sizeBytes !== undefined && source.sizeBytes > input.maxBytes) {
      throw new MediaInputLimitError("媒体输入超过临时缓存上限。");
    }
    if (source.sizeBytes !== undefined && source.rangeSupported) {
      try {
        await downloadRanges({ filePath, headers: input.headers, signal: input.signal, sizeBytes: source.sizeBytes, urls: source.urls });
      } catch (error) {
        if (!(error instanceof MediaRangeUnsupportedError)) throw error;
        await downloadSequential(source.urls, filePath, input.headers, source.sizeBytes, input.maxBytes, input.signal);
      }
    } else {
      await downloadSequential(source.urls, filePath, input.headers, source.sizeBytes, input.maxBytes, input.signal);
    }
    const sizeBytes = (await stat(filePath)).size;
    if (!sizeBytes) throw new Error("媒体流为空。");
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
  externalSignal?: AbortSignal,
): Promise<SourceProbe> {
  const candidates = [...new Set(urls)];
  const controller = new AbortController();
  const probeSignal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(DEFAULT_CONCURRENCY, candidates.length) }, async () => {
    let lastError: unknown;
    while (!probeSignal.aborted && nextIndex < candidates.length) {
      const url = candidates[nextIndex++];
      try {
        const signal = AbortSignal.any([probeSignal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
        const probe = await probeHead(url, headers, signal) ?? await probeRange(url, headers, signal);
        if (probe) return { ...probe, urls: prioritizeUrl(candidates, url) };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error("CDN 探测失败。", { cause: lastError });
  });
  try {
    return await Promise.any(workers);
  } catch (error) {
    externalSignal?.throwIfAborted();
    throw new Error("媒体 CDN 候选均不可用。", { cause: error });
  } finally {
    controller.abort();
    await Promise.allSettled(workers);
  }
}

async function probeHead(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Omit<SourceProbe, "urls"> | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers, method: "HEAD", signal });
  } catch (error) {
    signal.throwIfAborted();
    // Some CDNs reject HEAD while serving GET; the range probe decides availability.
    if (error instanceof TypeError) return null;
    throw error;
  }
  await response.body?.cancel();
  if (response.status !== 200) return null;
  const sizeBytes = readPositiveInteger(response.headers.get("content-length"));
  return {
    contentType: response.headers.get("content-type") || "application/octet-stream",
    rangeSupported: response.headers.get("accept-ranges")?.toLowerCase() === "bytes" && sizeBytes !== undefined,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

async function probeRange(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Omit<SourceProbe, "urls"> | null> {
  const response = await fetch(url, {
    headers: { ...headers, range: "bytes=0-0" },
    signal,
  });
  const contentRange = readContentRange(response.headers.get("content-range"));
  const rangeSupported = response.status === 206 && contentRange?.start === 0 && contentRange.end === 0;
  const sizeBytes = rangeSupported ? contentRange.size : response.status === 200
    ? readPositiveInteger(response.headers.get("content-length")) : undefined;
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  await response.body?.cancel();
  if (response.status === 206 && !rangeSupported) return null;
  if (response.ok && sizeBytes !== undefined) return { contentType, rangeSupported, sizeBytes };
  if (response.ok) return { contentType, rangeSupported: false };
  return null;
}

async function downloadRanges(input: {
  filePath: string;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  sizeBytes: number;
  urls: readonly string[];
}): Promise<void> {
  const file = await open(input.filePath, "w+");
  try {
    await file.truncate(input.sizeBytes);
  } finally {
    await file.close();
  }
  const count = Math.ceil(input.sizeBytes / DEFAULT_CHUNK_SIZE);
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(DEFAULT_CONCURRENCY, count) }, async () => {
    // Each worker owns its descriptor; only disjoint, explicit offsets are written concurrently.
    const workerFile = await open(input.filePath, "r+");
    try {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= count) return;
        const start = index * DEFAULT_CHUNK_SIZE;
        const end = Math.min(input.sizeBytes - 1, start + DEFAULT_CHUNK_SIZE - 1);
        await writeRange({ ...input, end, file: workerFile, signal, start });
      }
      signal.throwIfAborted();
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      await workerFile.close();
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    controller.abort();
    await Promise.allSettled(workers);
  }
}

async function writeRange(input: {
  end: number;
  file: Awaited<ReturnType<typeof open>>;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  sizeBytes: number;
  start: number;
  urls: readonly string[];
}): Promise<void> {
  let lastError: unknown;
  let offset = input.start;
  let failures = 0;
  // A whole chunk has one deadline, including all resumptions and CDN switches.
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  while (offset <= input.end && failures < MAX_ATTEMPTS) {
    const previousOffset = offset;
    for (const url of input.urls) {
      signal.throwIfAborted();
      try {
        await streamRange(url, {
          ...input,
          signal,
          start: offset,
          onWrite: (bytes) => { offset += bytes; },
        });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof MediaFileWriteError || error instanceof MediaRangeUnsupportedError) throw error;
        lastError = error;
      }
      if (offset > input.end) return;
    }
    failures = offset > previousOffset ? 0 : failures + 1;
  }
  throw new Error(`媒体分片下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

async function streamRange(
  url: string,
  input: Omit<Parameters<typeof writeRange>[0], "urls"> & { onWrite: (bytes: number) => void },
): Promise<void> {
  const response = await fetch(url, {
    headers: { ...input.headers, range: `bytes=${input.start}-${input.end}` },
    signal: input.signal,
  });
  const range = readContentRange(response.headers.get("content-range"));
  if (response.status === 200) {
    await response.body?.cancel();
    throw new MediaRangeUnsupportedError("媒体源未按 Range 返回分片。");
  }
  if (response.status !== 206 || !response.body || !range || range.start !== input.start ||
      range.end > input.end || range.size !== input.sizeBytes) {
    await response.body?.cancel();
    throw new Error(`媒体分片响应无效：HTTP ${response.status}。`);
  }

  const expectedSize = range.end - range.start + 1;
  let offset = input.start;
  let downloaded = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (downloaded + value.byteLength > expectedSize) {
        throw new Error("媒体分片响应超过声明的字节范围。");
      }
      let written = 0;
      while (written < value.byteLength) {
        input.signal.throwIfAborted();
        const { bytesWritten } = await input.file.write(value, written, value.byteLength - written, offset)
          .catch((cause: unknown) => { throw new MediaFileWriteError("媒体分片文件写入失败。", { cause }); });
        if (!bytesWritten) throw new MediaFileWriteError("媒体分片文件写入未取得进展。");
        written += bytesWritten;
        offset += bytesWritten;
        input.onWrite(bytesWritten);
      }
      downloaded += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
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
  expectedSize?: number,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (const url of urls) {
    signal?.throwIfAborted();
    try {
      const deadline = AbortSignal.timeout(SEQUENTIAL_TIMEOUT_MS);
      const response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      let downloaded = 0;
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            downloaded += chunk.byteLength;
            callback(maxBytes !== undefined && downloaded > maxBytes ? new MediaInputLimitError("媒体输入超过临时缓存上限。") : null, chunk);
          },
        }),
        createWriteStream(filePath),
      );
      if (expectedSize !== undefined && (await stat(filePath)).size !== expectedSize) {
        throw new Error("媒体长度不符。");
      }
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MediaInputLimitError) throw error;
      lastError = error;
    }
  }
  throw new Error(`媒体下载失败：${lastError instanceof Error ? lastError.message : "未知错误"}`);
}

function readPositiveInteger(value: string | null | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readContentRange(value: string | null): { start: number; end: number; size: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/iu);
  if (!match) return null;
  const [start, end, size] = match.slice(1).map(Number);
  return [start, end, size].every(Number.isSafeInteger) && start >= 0 && end >= start && size > end
    ? { start, end, size } : null;
}

function prioritizeUrl(urls: readonly string[], selected: string): string[] {
  return [selected, ...urls.filter((url) => url !== selected)];
}
