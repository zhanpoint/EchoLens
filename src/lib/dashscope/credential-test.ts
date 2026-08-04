import { buildDashScopeAsrParameters, type DashScopeAsrModelProfile } from "@/lib/dashscope/asr";
import {
  DASHSCOPE_FIXED_BASE_URL,
  DASHSCOPE_FIXED_COMPATIBLE_BASE_URL,
} from "@/lib/dashscope/fixed-config";
import type { DashScopeModelPurpose, EchoLensDashScopeModelIds } from "@/lib/dashscope/model-config";
import { buildPublicOssObjectUrl } from "@/lib/oss/object-store";

const ASR_TEST_TIMEOUT_MS = 30_000;
const CHAT_TEST_TIMEOUT_MS = 15_000;
const ASR_POLL_INTERVAL_MS = 400;
const TEST_PROMPT = "请只回复 OK。";
const CREDENTIAL_TEST_AUDIO_OBJECT_KEY = "echolens/tests/api-key-probe.m4a";

type CredentialTestAudio = { objectKey: string; signedUrl: string };
type TestDefinition =
  | { id: string; kind: "asr"; profile: DashScopeAsrModelProfile; purpose: DashScopeModelPurpose }
  | { id: string; kind: "chat" | "translation"; purpose: DashScopeModelPurpose };

export type DashScopeCredentialTestResult =
  | { id: string; ok: true; purpose: DashScopeModelPurpose }
  | { detail: string; id: string; ok: false; purpose: DashScopeModelPurpose };

export async function testDashScopeCredential(
  apiKey: string,
  models: EchoLensDashScopeModelIds,
  purpose?: DashScopeModelPurpose,
): Promise<{
  ok: boolean;
  results: DashScopeCredentialTestResult[];
}> {
  const definitions = readTestDefinitions(models, purpose);
  const audio = definitions.some(({ kind }) => kind === "asr") ? readCredentialTestAudio() : undefined;
  const tests = new Map<string, Promise<void>>();
  const results = await Promise.all(definitions.map(async (definition) => {
    try {
      const cacheKey = `${definition.kind}:${definition.kind === "asr" ? definition.profile : ""}:${definition.id}`;
      let test = tests.get(cacheKey);
      if (!test) {
        test = definition.kind === "asr"
          ? testAsrModel(apiKey, definition, audio)
          : testChatModel(apiKey, definition);
        tests.set(cacheKey, test);
      }
      await test;
      return {
        id: definition.id,
        ok: true as const,
        purpose: definition.purpose,
      } satisfies DashScopeCredentialTestResult;
    } catch (error) {
      return {
        detail: readErrorDetail(error, "模型测试失败。"),
        id: definition.id,
        ok: false as const,
        purpose: definition.purpose,
      } satisfies DashScopeCredentialTestResult;
    }
  }));
  return { ok: results.every((result) => result.ok), results };
}

function readTestDefinitions(models: EchoLensDashScopeModelIds, purpose?: DashScopeModelPurpose): TestDefinition[] {
  const definitions: TestDefinition[] = [
    {
      id: models.asrE1,
      kind: "asr",
      profile: "e1",
      purpose: "asrE1",
    },
    {
      id: models.asrE2,
      kind: "asr",
      profile: "e2",
      purpose: "asrE2",
    },
    {
      id: models.asrE3 ?? "qwen-audio-3.0-asr-flash-filetrans",
      kind: "asr",
      profile: "e3",
      purpose: "asrE3",
    },
    {
      id: models.translation,
      kind: "translation",
      purpose: "translation",
    },
    {
      id: models.transcriptPostprocess,
      kind: "chat",
      purpose: "transcriptPostprocess",
    },
    {
      id: models.summary,
      kind: "chat",
      purpose: "summary",
    },
  ];
  return purpose ? definitions.filter((definition) => definition.purpose === purpose) : definitions;
}

async function testAsrModel(
  apiKey: string,
  definition: Extract<TestDefinition, { kind: "asr" }>,
  audio: CredentialTestAudio | undefined,
): Promise<void> {
  if (!audio) {
    throw new Error("ASR 测试音频未配置。");
  }
  const profile = definition.profile;

  const payload = await fetchJson(`${DASHSCOPE_FIXED_BASE_URL}/services/audio/asr/transcription`, {
    apiKey,
    body: {
      input: profile === "e2" ? { file_urls: [audio.signedUrl] } : { file_url: audio.signedUrl },
      model: definition.id,
      parameters: buildDashScopeAsrParameters({ model: definition.id, profile }),
    },
    headers: { "x-dashscope-async": "enable" },
    method: "POST",
    timeoutMs: CHAT_TEST_TIMEOUT_MS,
  });
  const taskId = readStringPath(payload, ["output", "task_id"]);
  if (!taskId) {
    throw new Error("DashScope 没有返回 ASR 任务 ID。");
  }
  const result = await pollAsrTask(apiKey, taskId);
  const resultUrls = readResultUrls(result);
  if (resultUrls.length > 0) {
    await fetchJson(resultUrls[0], { method: "GET", timeoutMs: CHAT_TEST_TIMEOUT_MS });
  }
}

async function pollAsrTask(apiKey: string, taskId: string): Promise<unknown> {
  const deadline = Date.now() + ASR_TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const payload = await fetchJson(`${DASHSCOPE_FIXED_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
      apiKey,
      method: "GET",
      timeoutMs: CHAT_TEST_TIMEOUT_MS,
    });
    const status = readStringPath(payload, ["output", "task_status"]);
    if (status === "SUCCEEDED") {
      return payload;
    }
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(formatAsrTaskFailure(status, payload));
    }
    await delay(ASR_POLL_INTERVAL_MS);
  }
  throw new Error("ASR 测试超时，请检查业务空间模型权限和网络连接。");
}

function formatAsrTaskFailure(status: string, payload: unknown): string {
  const code = readStringPath(payload, ["output", "code"]);
  const message = readStringPath(payload, ["output", "message"]);
  const detail = [...new Set([code, message].filter((value): value is string => Boolean(value)))].join("：");
  return `ASR 任务${status === "FAILED" ? "失败" : "已取消"}${detail ? `：${detail}` : "。"}`;
}

async function testChatModel(apiKey: string, definition: TestDefinition): Promise<void> {
  const body = definition.kind === "translation"
    ? {
        messages: [{ content: "OK", role: "user" }],
        model: definition.id,
        stream: false,
        translation_options: { source_lang: "auto", target_lang: "English" },
      }
    : {
        enable_thinking: false,
        max_tokens: 8,
        messages: [{ content: TEST_PROMPT, role: "user" }],
        model: definition.id,
        stream: false,
        temperature: 0,
      };
  const payload = await fetchJson(`${DASHSCOPE_FIXED_COMPATIBLE_BASE_URL}/chat/completions`, {
    apiKey,
    body,
    method: "POST",
    timeoutMs: CHAT_TEST_TIMEOUT_MS,
  });
  const content = readStringPath(payload, ["choices", "0", "message", "content"]);
  if (!content) {
    throw new Error("模型没有返回可用文本。");
  }
}

function readCredentialTestAudio(): CredentialTestAudio {
  const bucket = readRequiredEnv("ALI_OSS_PUBLIC_BUCKET");
  return {
    objectKey: CREDENTIAL_TEST_AUDIO_OBJECT_KEY,
    signedUrl: buildPublicOssObjectUrl({ bucket, objectKey: CREDENTIAL_TEST_AUDIO_OBJECT_KEY }),
  };
}

async function fetchJson(url: string, input: {
  apiKey?: string;
  body?: unknown;
  headers?: Record<string, string>;
  method: "GET" | "POST";
  timeoutMs: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(url, {
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.headers ?? {}),
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
      },
      method: input.method,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(formatDashScopeTestError(response.status, payload));
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("请求超时，请检查网络连接。", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function formatDashScopeTestError(status: number, payload: unknown): string {
  const message = readStringPath(payload, ["message"]) || readStringPath(payload, ["error", "message"]);
  if (status === 401) return "API Key 无效或已过期。";
  if (status === 403) return "API Key 没有该模型的调用权限，或业务空间不匹配。";
  if (status === 429) return "请求触发限流，请稍后重试。";
  return message ? `模型请求失败：${message}` : `模型请求失败：HTTP ${status}`;
}

function readResultUrls(payload: unknown): string[] {
  const direct = readStringPath(payload, ["output", "result", "transcription_url"]);
  if (direct) return [direct];
  const results = readUnknownPath(payload, ["output", "results"]);
  return Array.isArray(results)
    ? results.flatMap((item) => {
        const url = item && typeof item === "object" ? (item as Record<string, unknown>).transcription_url : undefined;
        return typeof url === "string" && url ? [url] : [];
      })
    : [];
}

function readStringPath(payload: unknown, pathParts: string[]): string | undefined {
  const value = readUnknownPath(payload, pathParts);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readUnknownPath(payload: unknown, pathParts: string[]): unknown {
  return pathParts.reduce<unknown>((current, part) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
    return undefined;
  }, payload);
}

function readErrorDetail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置。`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
