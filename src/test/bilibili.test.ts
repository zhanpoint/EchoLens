import { afterEach, describe, expect, it, vi } from "vitest";
import { bilibiliMediaHeaders, getBilibiliDashSelection, resolveBilibiliWork } from "@/lib/bilibili/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bilibili client", () => {
  it.runIf(process.env.BILIBILI_LIVE_TEST === "1")(
    "resolves the requested public b23 work through the live WBI API",
    async () => {
      vi.unstubAllGlobals();
      const result = await resolveBilibiliWork("https://b23.tv/vU8bJum");
      expect(result.work.bvid).toMatch(/^BV[\p{L}\p{N}]+$/iu);
      expect(result.work.cid).toBeGreaterThan(0);
      expect(result.work.caption).toContain("MedRGAG");
      expect(result.metadata.durationSeconds).toBeGreaterThan(0);
      const selection = await getBilibiliDashSelection({
        bvid: result.work.bvid,
        cid: result.work.cid,
        codec: "avc",
        videoQuality: "lowest",
      });
      expect(selection.audio.urls.length).toBeGreaterThan(0);
      expect(selection.video.urls.length).toBeGreaterThan(0);
      const probe = await fetch(selection.audio.urls[0], {
        headers: { ...bilibiliMediaHeaders(), range: "bytes=0-1023" },
      });
      expect([200, 206]).toContain(probe.status);
      await probe.body?.cancel();
    },
    30_000,
  );

  it("accepts a bare BV id and resolves it through the WBI view API", async () => {
    const requests: string[] = [];
    const responses = [
      jsonResponse(navPayload()),
      jsonResponse({
        code: 0,
        data: {
          aid: 1,
          bvid: "BV1xx411c7mD",
          cid: 100,
          duration: 30,
          owner: { face: "//i.example/avatar.jpg", mid: 42, name: "UP 主" },
          pages: [{ cid: 100, duration: 30, page: 1, part: "第一 P" }],
          pic: "//i.example/cover.jpg",
          title: "总标题",
        },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }));

    const result = await resolveBilibiliWork("BV1xx411c7mD");

    expect(result.work).toMatchObject({
      bvid: "BV1xx411c7mD",
      cid: 100,
      id: "BV1xx411c7mD:100",
      page: 1,
    });
    const viewUrl = new URL(requests[1]);
    expect(viewUrl.origin + viewUrl.pathname).toBe("https://api.bilibili.com/x/web-interface/wbi/view");
    expect(viewUrl.searchParams.get("bvid")).toBe("BV1xx411c7mD");
    expect(viewUrl.searchParams.get("w_rid")).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("follows b23, signs WBI view requests, and selects the requested part CID", async () => {
    const requests: string[] = [];
    const responses = [
      response({}, "https://www.bilibili.com/video/BV1xx411c7mD?p=2"),
      jsonResponse(navPayload()),
      jsonResponse({
        code: 0,
        data: {
          aid: 1,
          bvid: "BV1xx411c7mD",
          cid: 100,
          duration: 30,
          owner: { face: "//i.example/avatar.jpg", mid: 42, name: "UP 主" },
          pages: [
            { cid: 100, duration: 30, page: 1, part: "第一 P" },
            { cid: 200, duration: 45, page: 2, part: "第二 P" },
          ],
          pic: "//i.example/cover.jpg",
          title: "总标题",
        },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }));

    const result = await resolveBilibiliWork("分享 https://b23.tv/vU8bJum");

    expect(result.work).toMatchObject({
      bvid: "BV1xx411c7mD",
      caption: "第二 P",
      cid: 200,
      id: "BV1xx411c7mD:200",
      page: 2,
      source: "bilibili",
    });
    expect(result.work.finalUrl).toContain("?p=2");
    expect(result.metadata.authorAvatarUrls).toEqual(["https://i.example/avatar.jpg"]);
    const viewUrl = new URL(requests[2]);
    expect(viewUrl.searchParams.get("bvid")).toBe("BV1xx411c7mD");
    expect(viewUrl.searchParams.get("wts")).toMatch(/^\d+$/u);
    expect(viewUrl.searchParams.get("w_rid")).toMatch(/^[a-f0-9]{32}$/u);
  });

  it("applies configurable playurl format, video quality, codec, and audio quality", async () => {
    const requests: string[] = [];
    const responses = [
      jsonResponse(navPayload()),
      jsonResponse({
        code: 0,
        data: {
          dash: {
            audio: [stream(30216, 64_000, 0), stream(30280, 192_000, 0)],
            flac: { audio: stream(0, 1_411_000, 0) },
            video: [
              { ...stream(80, 900_000, 7), height: 1080 },
              { ...stream(120, 1_400_000, 13), height: 2160 },
            ],
          },
        },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }));

    const selection = await getBilibiliDashSelection({
      audioQuality: "hiRes",
      bvid: "BV1xx411c7mD",
      cid: 100,
      codec: "av1",
      streamFormat: "dashFull",
      videoQuality: "2160p",
    });

    expect(selection.audio.id).toBe(30251);
    expect(selection.video).toMatchObject({ codecId: 13, height: 2160, id: 120 });
    const playUrl = new URL(requests[1]);
    expect(playUrl.searchParams.get("fnver")).toBe("0");
    expect(playUrl.searchParams.get("fnval")).toBe("4048");
    expect(playUrl.searchParams.get("fourk")).toBe("1");
    expect(playUrl.searchParams.get("qn")).toBe("120");
  });

  it("selects the lowest audio and preferred AVC video stream", async () => {
    const requests: string[] = [];
    const responses = [
      jsonResponse(navPayload()),
      jsonResponse({
        code: 0,
        data: {
          dash: {
            audio: [
              stream(30280, 192_000, 0),
              stream(30216, 64_000, 0),
            ],
            video: [
              { ...stream(64, 500_000, 12), height: 360 },
              { ...stream(64, 700_000, 7), height: 720 },
              { ...stream(32, 300_000, 7), height: 360 },
            ],
          },
        },
      }),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    });
    vi.stubGlobal("fetch", fetchMock);

    const selection = await getBilibiliDashSelection({
      bvid: "BV1xx411c7mD",
      cid: 100,
      codec: "avc",
      videoQuality: "lowest",
    });

    expect(selection.audio.id).toBe(30216);
    expect(selection.video).toMatchObject({ codecId: 7, height: 360, id: 32 });
    const playUrl = new URL(requests[1]);
    expect(playUrl.searchParams.get("fnval")).toBe("4048");
    expect(playUrl.searchParams.get("qn")).toBe("16");
    expect(playUrl.searchParams.get("w_rid")).toMatch(/^[a-f0-9]{32}$/u);
  });
});

function navPayload() {
  return {
    code: 0,
    data: {
      isLogin: false,
      wbi_img: {
        img_url: "https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png",
        sub_url: "https://i0.hdslb.com/bfs/wbi/ABCDEFGHIJKLMNOPQRSTUVWXYZ987654.png",
      },
    },
  };
}

function stream(id: number, bandwidth: number, codecid: number) {
  return {
    backupUrl: [`https://backup.example/${id}`],
    bandwidth,
    baseUrl: `https://cdn.example/${id}`,
    codecid,
    id,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function response(payload: unknown, url: string): Response {
  const value = jsonResponse(payload);
  Object.defineProperty(value, "url", { configurable: true, value: url });
  return value;
}
