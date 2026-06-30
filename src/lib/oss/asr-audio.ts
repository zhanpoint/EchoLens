import { createHash, createHmac } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { fetchWithRetry } from "@/lib/http/retry";

export type UploadedAsrAudio = {
  objectKey: string;
  signedUrl: string;
};

type OssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  prefix: string;
  signedUrlExpiresSeconds: number;
};

const DEFAULT_ASR_PREFIX = "echolens/asr/";
const DEFAULT_SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;
const OSS_REQUEST_TIMEOUT_MS = 120_000;
const SIGNED_URL_CHECK_TIMEOUT_MS = 20_000;

export async function uploadAsrAudioFile(input: {
  filePath: string;
  userId: string;
  workKey: string;
}): Promise<UploadedAsrAudio> {
  const stat = await fs.stat(input.filePath);
  if (stat.size === 0) {
    throw new Error("没有可上传的音频内容。");
  }

  const config = readOssConfig();
  const objectKey = buildAsrObjectKey(config.prefix, input.userId, input.workKey);
  if (!(await objectExists(config, objectKey))) {
    await requestOssObject(config, objectKey, {
      body: Readable.toWeb(createReadStream(input.filePath)) as BodyInit,
      contentLength: stat.size,
      contentType: "audio/wav",
      method: "PUT",
    });
  }

  const signedUrl = buildSignedGetUrl(config, objectKey);
  await assertSignedUrlIsPubliclyReadable(signedUrl);

  return { objectKey, signedUrl };
}

export function isManagedAsrAudioUrl(input: {
  objectKey: string;
  signedUrl: string;
}): boolean {
  try {
    const config = readOssConfig();
    const signedUrl = new URL(input.signedUrl);
    const objectUrl = new URL(buildObjectUrl(config, input.objectKey));
    return (
      input.objectKey.startsWith(config.prefix) &&
      input.objectKey.endsWith(".wav") &&
      signedUrl.protocol === "https:" &&
      signedUrl.origin === objectUrl.origin &&
      signedUrl.pathname === objectUrl.pathname &&
      Boolean(signedUrl.searchParams.get("OSSAccessKeyId")) &&
      Boolean(signedUrl.searchParams.get("Expires")) &&
      Boolean(signedUrl.searchParams.get("Signature"))
    );
  } catch {
    return false;
  }
}

async function objectExists(config: OssConfig, objectKey: string): Promise<boolean> {
  const response = await signedOssRequest(config, objectKey, { method: "HEAD" });
  await response.body?.cancel();
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`OSS HEAD 临时音频对象失败：HTTP ${response.status}`);
  }

  return true;
}

async function requestOssObject(
  config: OssConfig,
  objectKey: string,
  input: {
    body?: BodyInit;
    contentLength?: number;
    contentType?: string;
    method: "PUT";
  },
): Promise<void> {
  const response = await signedOssRequest(config, objectKey, input);
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`OSS ${input.method} 临时音频对象失败：HTTP ${response.status}`);
  }
}

async function signedOssRequest(
  config: OssConfig,
  objectKey: string,
  input: {
    body?: BodyInit;
    contentLength?: number;
    contentType?: string;
    method: "HEAD" | "PUT";
  },
): Promise<Response> {
  const date = new Date().toUTCString();
  const contentType = input.contentType ?? "";
  const request = {
    body: input.body,
    duplex: input.body ? "half" : undefined,
    headers: {
      authorization: signOssRequest(config, {
        contentType,
        date,
        method: input.method,
        objectKey,
      }),
      date,
      ...(input.contentLength !== undefined ? { "content-length": String(input.contentLength) } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    method: input.method,
    timeoutMs: OSS_REQUEST_TIMEOUT_MS,
  } satisfies RequestInit & { duplex?: "half"; method: "HEAD" | "PUT"; timeoutMs: number };

  if (input.method === "HEAD") {
    const { timeoutMs, ...requestInit } = request;
    return await fetchWithRetry(buildObjectUrl(config, objectKey), {
      ...requestInit,
      retry: { timeoutMs },
    });
  }

  return await fetchWithTimeout(buildObjectUrl(config, objectKey), request);
}

function buildSignedGetUrl(config: OssConfig, objectKey: string): string {
  const expires = Math.floor(Date.now() / 1000) + config.signedUrlExpiresSeconds;
  const signature = signOssCanonicalString(
    config.accessKeySecret,
    ["GET", "", "", String(expires), canonicalResource(config.bucket, objectKey)].join("\n"),
  );
  const url = new URL(buildObjectUrl(config, objectKey));
  url.searchParams.set("OSSAccessKeyId", config.accessKeyId);
  url.searchParams.set("Expires", String(expires));
  url.searchParams.set("Signature", signature);
  return url.toString();
}

async function assertSignedUrlIsPubliclyReadable(signedUrl: string): Promise<void> {
  const response = await fetchWithRetry(signedUrl, {
    method: "GET",
    retry: { timeoutMs: SIGNED_URL_CHECK_TIMEOUT_MS },
  });
  await response.body?.cancel();

  if (response.status !== 200) {
    throw new Error(`OSS 签名音频 URL 公网访问校验失败：HTTP ${response.status}`);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { duplex?: "half"; timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const { timeoutMs, ...requestInit } = init;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...requestInit,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "OSS 网络请求失败。");
  } finally {
    clearTimeout(timeout);
  }
}

function signOssRequest(
  config: OssConfig,
  input: {
    contentType: string;
    date: string;
    method: "HEAD" | "PUT";
    objectKey: string;
  },
): string {
  const canonicalString = [
    input.method,
    "",
    input.contentType,
    input.date,
    canonicalResource(config.bucket, input.objectKey),
  ].join("\n");
  return `OSS ${config.accessKeyId}:${signOssCanonicalString(config.accessKeySecret, canonicalString)}`;
}

function signOssCanonicalString(accessKeySecret: string, canonicalString: string): string {
  return createHmac("sha1", accessKeySecret).update(canonicalString).digest("base64");
}

function canonicalResource(bucket: string, objectKey: string): string {
  return `/${bucket}/${objectKey}`;
}

function buildObjectUrl(config: OssConfig, objectKey: string): string {
  return `${config.endpoint.replace(/\/$/, "")}/${encodeObjectKey(objectKey)}`;
}

function readOssConfig(): OssConfig {
  const bucket = readRequiredEnv("ALI_OSS_BUCKET");
  const endpoint = normalizeEndpoint(readRequiredEnv("ALI_OSS_ENDPOINT"), bucket);

  return {
    accessKeyId: readRequiredEnv("ALI_OSS_ACCESS_KEY_ID"),
    accessKeySecret: readRequiredEnv("ALI_OSS_ACCESS_KEY_SECRET"),
    bucket,
    endpoint,
    prefix: normalizePrefix(process.env.ALI_OSS_ASR_PREFIX || DEFAULT_ASR_PREFIX),
    signedUrlExpiresSeconds: readPositiveInteger(
      process.env.ALI_OSS_SIGNED_URL_EXPIRES_SECONDS,
      DEFAULT_SIGNED_URL_EXPIRES_SECONDS,
    ),
  };
}

function normalizeEndpoint(endpoint: string, bucket: string): string {
  const parsed = new URL(endpoint.startsWith("http") ? endpoint : `https://${endpoint}`);
  if (!parsed.hostname.startsWith(`${bucket}.`)) {
    parsed.hostname = `${bucket}.${parsed.hostname}`;
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function buildAsrObjectKey(prefix: string, userId: string, workKey: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const userHash = sha256(userId).slice(0, 16);
  const workHash = sha256(workKey).slice(0, 24);
  return `${prefix}${date}/${userHash}/${workHash}.wav`;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置。`);
  }
  return value;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, "");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
