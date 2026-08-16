import { afterEach, describe, expect, it, vi } from "vitest";
import { createDouyinWebClient } from "@/lib/douyin/web-client";

const TOKEN = "m".repeat(164);
const CONFIG = `f2:
  douyin:
    msToken:
      url: https://mssdk.bytedance.com/web/r/token?ms_appid=6383
      magic: 538969122
      version: 1
      dataType: 8
      ulr: 0
      strData: payload
    ttwid:
      url: https://example.com
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("douyin web request fingerprint", () => {
  it("generates a real msToken when the cookie does not contain one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(CONFIG))
      .mockResolvedValueOnce(new Response(null, {
        headers: { "set-cookie": `msToken=${TOKEN}; Path=/; Secure` },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status_code: 0,
        user: { sec_uid: "self-sec" },
      })));

    const client = createDouyinWebClient("sessionid=session");
    await expect(client.getSelfProfile(1)).resolves.toMatchObject({ sec_uid: "self-sec" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2];
    expect(String(url)).toContain(`msToken=${TOKEN}`);
    expect(String(url)).toContain("a_bogus=");
    expect(String(url)).not.toContain("X-Bogus=");
    expect(init?.headers).toMatchObject({
      cookie: `sessionid=session; msToken=${TOKEN}`,
    });
  });

  it("re-signs an empty anti-bot response instead of invalidating the cookie", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(""))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status_code: 0, value: "ok" })));
    const client = createDouyinWebClient(`sessionid=session; msToken=${TOKEN}`);

    await expect(client.request("/aweme/v1/web/aweme/detail/", {
      ...client.query(),
      aweme_id: "123",
    }, 2)).resolves.toMatchObject({ value: "ok" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).not.toBe(String(fetchMock.mock.calls[1][0]));
  });

  it.each([
    [403, "ACCESS_BLOCKED"],
    [429, "RATE_LIMITED"],
  ] as const)("classifies HTTP %s independently", async (status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("blocked", { status }));
    const client = createDouyinWebClient(`sessionid=session; msToken=${TOKEN}`);

    await expect(client.request("/aweme/v1/web/aweme/detail/", {
      ...client.query(),
      aweme_id: "123",
    }, 1)).rejects.toMatchObject({ code });
  });
});