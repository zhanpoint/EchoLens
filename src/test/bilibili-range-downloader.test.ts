import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBilibiliStream } from "@/lib/bilibili/range-downloader";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bilibili range downloader", () => {
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

    const downloaded = await downloadBilibiliStream({
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

    const downloaded = await downloadBilibiliStream({
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
