import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/auth/_shared", () => ({
  requireUser: vi.fn(async () => ({ email: "test@example.com", id: "user-1", username: "test" })),
}));

const settingsStore = new Map<string, unknown>();

vi.mock("@/lib/user-settings", () => ({
  isUserSettingsCategory: (value: string) => ["aiCredential", "aiModels", "bilibili", "douyin", "download", "transcript", "translation"].includes(value),
  readUserSettings: vi.fn(async (
    userId: string,
    options: { includeDouyin?: boolean } = {},
  ) => ({
    ...(settingsStore.has(`${userId}:aiCredential`) ? { aiCredential: settingsStore.get(`${userId}:aiCredential`) } : {}),
    aiModels: settingsStore.get(`${userId}:aiModels`),
    ...(settingsStore.has(`${userId}:bilibili`) ? { bilibili: settingsStore.get(`${userId}:bilibili`) } : {}),
    ...(options.includeDouyin === false ? {} : { douyin: settingsStore.get(`${userId}:douyin`) }),
    ...(settingsStore.has(`${userId}:download`) ? { download: settingsStore.get(`${userId}:download`) } : {}),
    transcript: settingsStore.get(`${userId}:transcript`),
    translation: settingsStore.get(`${userId}:translation`),
  })),
  upsertUserSetting: vi.fn(async (userId: string, category: string, value: unknown) => {
    settingsStore.set(`${userId}:${category}`, value);
  }),
}));

vi.mock("@/lib/douyin/account", () => ({
  validateAndStoreDouyinCredential: vi.fn(async (userId: string, cookie: string) => {
    settingsStore.set(`${userId}:douyin`, {
      cookie,
      credentialCheckedAt: 1_234,
      credentialStatus: cookie ? "valid" : "missing",
    });
  }),
}));

vi.mock("@/lib/bilibili/account", () => ({
  BilibiliCredentialError: class BilibiliCredentialError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  },
  validateAndStoreBilibiliCredential: vi.fn(async (userId: string, cookie: string) => {
    settingsStore.set(`${userId}:bilibili`, {
      cookie,
      credentialCheckedAt: 2_468,
      credentialStatus: cookie ? "valid" : "missing",
      ...(cookie ? { username: "bili-user" } : {}),
    });
  }),
}));

import { requireUser } from "@/app/api/auth/_shared";
import { validateAndStoreBilibiliCredential } from "@/lib/bilibili/account";
import { validateAndStoreDouyinCredential } from "@/lib/douyin/account";
import { GET, PUT } from "@/app/api/user/settings/route";
import { DEFAULT_DASHSCOPE_MODELS } from "@/lib/dashscope/model-config";

const requireUserMock = vi.mocked(requireUser);
const validateBilibiliCredentialMock = vi.mocked(validateAndStoreBilibiliCredential);
const validateDouyinCredentialMock = vi.mocked(validateAndStoreDouyinCredential);

describe("user settings route", () => {
  beforeEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
    settingsStore.clear();
    vi.clearAllMocks();
    requireUserMock.mockResolvedValue({ email: "test@example.com", id: "user-1", username: "test" });
  });

  afterEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
  });

  it("hides stored Douyin credentials and rejects updates when disabled", async () => {
    settingsStore.set("user-1:douyin", { cookie: "sessionid=secret", credentialStatus: "valid" });
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";

    const getResponse = await GET(new Request("https://echolens.test/api/user/settings"));
    expect((await getResponse.json()).settings).not.toHaveProperty("douyin");
    requireUserMock.mockClear();

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "douyin", value: { cookie: "sessionid=new" } }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(503);
    expect(await putResponse.json()).toMatchObject({ code: "DOUYIN_ACCOUNT_SERVICES_DISABLED" });
    expect(requireUserMock).toHaveBeenCalledOnce();
    expect(validateDouyinCredentialMock).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    requireUserMock.mockResolvedValue(NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 }));

    const response = await GET(new Request("https://echolens.test/api/user/settings"));

    expect(response.status).toBe(401);
  });

  it("persists translation settings for the current user", async () => {
    const value = {
      domains: "Translate as product UI copy.",
      showSource: false,
      targetLang: "English",
      termsText: "EchoLens => EchoLens",
      tmText: "",
    };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "translation", value }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(200);

    const getResponse = await GET(new Request("https://echolens.test/api/user/settings"));
    expect(await getResponse.json()).toEqual({
      settings: {
        aiModels: DEFAULT_DASHSCOPE_MODELS,
        transcript: undefined,
        translation: value,
      },
    });
  });

  it("persists an AI API key without returning the secret", async () => {
    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "aiCredential", value: { apiKey: "sk-user-secret" } }),
      method: "PUT",
    }));

    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual({
      settings: {
        aiCredential: { configured: true },
        aiModels: DEFAULT_DASHSCOPE_MODELS,
        transcript: undefined,
        translation: undefined,
      },
    });
    expect(settingsStore.get("user-1:aiCredential")).toEqual({ apiKey: "sk-user-secret" });
  });

  it("persists transcript settings for the current user", async () => {
    const value = { includeSpeakerEmotion: true, showSpeaker: false, showSpeakerEmotion: true };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "transcript", value }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(200);

    const getResponse = await GET(new Request("https://echolens.test/api/user/settings"));
    expect(await getResponse.json()).toEqual({
      settings: {
        aiModels: DEFAULT_DASHSCOPE_MODELS,
        transcript: value,
        translation: undefined,
      },
    });
  });

  it("persists douyin settings for the current user", async () => {
    const value = { cookie: "sessionid=abc; msToken=token" };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "douyin", value }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(200);

    const getResponse = await GET(new Request("https://echolens.test/api/user/settings"));
    expect(await getResponse.json()).toEqual({
      settings: {
        aiModels: DEFAULT_DASHSCOPE_MODELS,
        douyin: {
          ...value,
          credentialCheckedAt: 1_234,
          credentialStatus: "valid",
        },
        transcript: undefined,
        translation: undefined,
      },
    });
  });

  it("persists bilibili settings through credential validation state", async () => {
    const value = { cookie: "SESSDATA=abc; bili_jct=csrf" };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "bilibili", value }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(200);
    expect(validateBilibiliCredentialMock).toHaveBeenCalledWith("user-1", value.cookie);

    const getResponse = await GET(new Request("https://echolens.test/api/user/settings"));
    expect(await getResponse.json()).toEqual({
      settings: {
        aiModels: DEFAULT_DASHSCOPE_MODELS,
        bilibili: {
          ...value,
          credentialCheckedAt: 2_468,
          credentialStatus: "valid",
          username: "bili-user",
        },
        transcript: undefined,
        translation: undefined,
      },
    });
  });

  it("persists video quality with lowest quality as the supported default", async () => {
    const value = {
      bilibiliAudioQuality: "hiRes",
      bilibiliVideoCodec: "av1",
      bilibiliVideoQuality: "2160p",
      directoryPath: "Downloads",
      organization: "work",
      videoQuality: "1080p",
    };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "download", value }),
      method: "PUT",
    }));

    expect(putResponse.status).toBe(200);
    expect(settingsStore.get("user-1:download")).toEqual(value);
    await expect(putResponse.json()).resolves.toMatchObject({ settings: { download: value } });

    const defaultResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "download", value: { directoryPath: "", organization: "work" } }),
      method: "PUT",
    }));
    await expect(defaultResponse.json()).resolves.toMatchObject({
      settings: {
        download: {
          bilibiliAudioQuality: "lowest",
          bilibiliVideoQuality: "lowest",
          videoQuality: "lowest",
        },
      },
    });
  });

  it("persists only supported AI model selections", async () => {
    const models = {
      asrE1: "qwen3-asr-flash-filetrans-2025-11-17",
      asrE2: "fun-asr-2025-11-07",
      translation: "qwen-mt-plus",
      transcriptPostprocess: "qwen3.7-plus",
      summary: "qwen3.5-flash",
    };

    const putResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "aiModels", value: models }),
      method: "PUT",
    }));
    expect(putResponse.status).toBe(200);
    expect(settingsStore.get("user-1:aiModels")).toEqual(models);

    const invalidResponse = await PUT(new Request("https://echolens.test/api/user/settings", {
      body: JSON.stringify({ category: "aiModels", value: { ...models, summary: "arbitrary-model" } }),
      method: "PUT",
    }));
    expect(invalidResponse.status).toBe(400);
  });
});
