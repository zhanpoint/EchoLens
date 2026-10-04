import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMediaFile } from "@/lib/media/range-downloader";

const mocks = vi.hoisted(() => ({ onOpen: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      mocks.onOpen(file);
      return file;
    },
  };
});

afterEach(() => {
  mocks.onOpen.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media range downloader", () => {
  it("restarts sequentially when a source advertises ranges but ignores Range requests", async () => {
    const source = Uint8Array.of(1, 2, 3, 4);
    const fetch = vi.fn(async (_url, init?: RequestInit) => init?.method === "HEAD" ? rangeHead(4) : new Response(source));
    vi.stubGlobal("fetch", fetch);
    const file = await downloadMediaFile({ headers: {}, name: "audio.m4s", urls: ["https://cdn.example/audio"] });
    try {
      expect((await readFile(file.filePath)).equals(Buffer.from(source))).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await file.cleanup();
    }
  });

  it("stops immediately when a local write fails instead of retrying CDNs", async () => {
    mocks.onOpen.mockImplementation((file) => {
      vi.spyOn(file, "write").mockResolvedValue({ bytesWritten: 0 });
    });
    const fetch = vi.fn(async (_url, init?: RequestInit) => init?.method === "HEAD" ? rangeHead(4)
      : new Response(Uint8Array.of(1, 2, 3, 4), { status: 206, headers: { "content-range": "bytes 0-3/4" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadMediaFile({ headers: {}, name: "audio.m4s", urls: ["https://cdn.example/audio"] }))
      .rejects.toThrow("文件写入未取得进展");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces the size limit before preallocating a ranged file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rangeHead(100)));
    await expect(downloadMediaFile({ headers: {}, maxBytes: 50, name: "video.m4s", urls: ["https://cdn.example/video"] }))
      .rejects.toThrow("缓存上限");
    expect(mocks.onOpen).not.toHaveBeenCalled();
  });

  it("limits sequential bodies even when their length is unknown", async () => {
    const fetch = vi.fn(async (_url, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null) : new Response(Uint8Array.of(1, 2, 3, 4, 5)));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadMediaFile({ headers: {}, maxBytes: 4, name: "video.m4s", urls: ["https://cdn.example/video"] }))
      .rejects.toThrow("缓存上限");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("resumes a truncated body from the bytes actually written", async () => {
    const source = Uint8Array.of(1, 2, 3, 4, 5, 6);
    const ranges: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "HEAD") return rangeHead(source.length);
      const range = new Headers(init?.headers).get("range")!;
      ranges.push(range);
      const start = Number(range.match(/bytes=(\d+)-/u)![1]);
      return new Response(source.slice(start, start + 2), {
        status: 206, headers: { "content-range": `bytes ${start}-5/6` },
      });
    }));
    const file = await downloadMediaFile({ headers: {}, name: "audio.m4s", urls: ["https://cdn.example/audio"] });
    try {
      expect(ranges).toEqual(["bytes=0-5", "bytes=2-5", "bytes=4-5"]);
      expect((await readFile(file.filePath)).equals(Buffer.from(source))).toBe(true);
    } finally {
      await file.cleanup();
    }
  });

  it("handles partial filesystem writes without skipping bytes", async () => {
    mocks.onOpen.mockImplementation((file) => {
      const write = file.write.bind(file);
      vi.spyOn(file, "write").mockImplementation((...args: unknown[]) => {
        args[2] = Math.min(Number(args[2]), 1);
        return write(...args);
      });
    });
    const source = Uint8Array.of(10, 20, 30, 40);
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => init?.method === "HEAD"
      ? rangeHead(source.length)
      : new Response(source, { status: 206, headers: { "content-range": "bytes 0-3/4" } })));
    const file = await downloadMediaFile({ headers: {}, name: "audio.m4s", urls: ["https://cdn.example/audio"] });
    try {
      expect((await readFile(file.filePath)).equals(Buffer.from(source))).toBe(true);
    } finally {
      await file.cleanup();
    }
  });

  it("rejects oversized responses before they overwrite the adjacent chunk", async () => {
    const size = 4 * 1024 * 1024 + 4;
    const source = new Uint8Array(size).fill(0x5a);
    source.fill(0x77, size - 4);
    vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
      if (init?.method === "HEAD") return rangeHead(size);
      const range = new Headers(init?.headers).get("range")!;
      const [, startText, endText] = range.match(/bytes=(\d+)-(\d+)/u)!;
      const start = Number(startText);
      const end = Number(endText);
      const body = String(input).includes("primary") && start === 0
        ? new Uint8Array(end + 2).fill(0xff) : source.slice(start, end + 1);
      return new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${size}` } });
    }));
    const file = await downloadMediaFile({
      headers: {}, name: "video.m4s", urls: ["https://primary.example/video", "https://backup.example/video"],
    });
    try {
      expect((await readFile(file.filePath)).equals(Buffer.from(source))).toBe(true);
    } finally {
      await file.cleanup();
    }
  });

  it("rejects a mismatched Content-Range and selects a valid backup", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
      if (init?.method === "HEAD") return rangeHead(4);
      return String(input).includes("primary")
        ? new Response(Uint8Array.of(9, 9, 9, 9), { status: 206, headers: { "content-range": "bytes 4-7/8" } })
        : new Response(Uint8Array.of(1, 2, 3, 4), { status: 206, headers: { "content-range": "bytes 0-3/4" } });
    }));
    const file = await downloadMediaFile({
      headers: {}, name: "audio.m4s", urls: ["https://primary.example/audio", "https://backup.example/audio"],
    });
    try {
      expect(await readFile(file.filePath)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      await file.cleanup();
    }
  });

  it("does not let a slow primary probe block a healthy backup", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (input, init?: RequestInit) => {
      if (String(input).includes("slow")) return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { cancelled = true; reject(init.signal?.reason); }, { once: true });
      });
      return init?.method === "HEAD" ? rangeHead(4)
        : new Response(Uint8Array.of(1, 2, 3, 4), { status: 206, headers: { "content-range": "bytes 0-3/4" } });
    }));
    const file = await downloadMediaFile({
      headers: {}, name: "audio.m4s", urls: ["https://slow.example/audio", "https://healthy.example/audio"],
    });
    try {
      expect(cancelled).toBe(true);
      expect(await readFile(file.filePath)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      await file.cleanup();
    }
  });

  it("aborts sibling range requests before releasing a failed download", async () => {
    let siblingAborted = false;
    let markSiblingStarted: () => void = () => undefined;
    const siblingStarted = new Promise<void>((resolve) => { markSiblingStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) => {
      if (init?.method === "HEAD") return rangeHead(4 * 1024 * 1024 + 4);
      if (new Headers(init?.headers).get("range")?.startsWith("bytes=0-")) {
        await siblingStarted;
        return new Response(null, { status: 503 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { siblingAborted = true; reject(init.signal?.reason); }, { once: true });
        markSiblingStarted();
      });
    }));
    await expect(downloadMediaFile({ headers: {}, name: "video.m4s", urls: ["https://cdn.example/video"] }))
      .rejects.toThrow("分片下载失败");
    expect(siblingAborted).toBe(true);
  });

  it("rejects a truncated sequential download with a known source size", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input, init?: RequestInit) => init?.method === "HEAD"
      ? new Response(null, { headers: { "content-length": "4" } }) : new Response(Uint8Array.of(1, 2))));
    await expect(downloadMediaFile({ headers: {}, name: "audio.m4s", urls: ["https://cdn.example/audio"] }))
      .rejects.toThrow("媒体长度不符");
  });

  it("falls back to a backup CDN when a ranged chunk fails on the primary", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("range");
      requests.push(`${url} ${range}`);
      if (range === "bytes=0-0") {
        return new Response(source.slice(0, 1), {
          headers: { "content-range": "bytes 0-0/4" },
          status: 206,
        });
      }
      if (url.includes("primary")) return new Response(null, { status: 503 });
      return new Response(source, { headers: { "content-range": "bytes 0-3/4" }, status: 206 });
    }));

    const downloaded = await downloadMediaFile({
      headers: {},
      name: "audio.m4s",
      urls: ["https://primary.example/audio", "https://backup.example/audio"],
    });
    try {
      expect(requests).toContain("https://primary.example/audio bytes=0-3");
      expect(requests).toContain("https://backup.example/audio bytes=0-3");
      expect((await readFile(downloaded.filePath)).equals(Buffer.from(source))).toBe(true);
    } finally {
      await downloaded.cleanup();
    }
  });

  it("downloads bounded 4 MB ranges into their original file offsets", async () => {
    const size = 4 * 1024 * 1024 + 17;
    const source = new Uint8Array(size);
    source.fill(0x5a);
    const requestedRanges: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      if (range === "bytes=0-0") {
        return new Response(source.slice(0, 1), {
          headers: {
            "content-range": `bytes 0-0/${size}`,
            "content-type": "audio/mp4",
          },
          status: 206,
        });
      }
      const match = range?.match(/^bytes=(\d+)-(\d+)$/u);
      if (!match) return new Response(null, { status: 416 });
      requestedRanges.push(range!);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(source.slice(start, end + 1), {
        headers: { "content-range": `bytes ${start}-${end}/${size}` },
        status: 206,
      });
    }));

    const downloaded = await downloadMediaFile({
      headers: { referer: "https://www.bilibili.com/" },
      name: "audio.m4s",
      urls: ["https://cdn.example/audio.m4s"],
    });
    try {
      expect(requestedRanges).toEqual([
        "bytes=0-4194303",
        `bytes=4194304-${size - 1}`,
      ]);
      expect((await readFile(downloaded.filePath)).equals(Buffer.from(source))).toBe(true);
    } finally {
      await downloaded.cleanup();
    }
  });
});

function rangeHead(size: number): Response {
  return new Response(null, { headers: { "accept-ranges": "bytes", "content-length": String(size) } });
}
