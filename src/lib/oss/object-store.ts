import { createHmac } from "node:crypto";
import {
  fetchWithRetry,
  isRetryableHttpStatus,
  NetworkRetryExhaustedError,
} from "@/lib/http/retry";

type OssConfig = {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  signedUrlExpiresSeconds: number;
};

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SIGNED_URL_EXPIRES_SECONDS = 6 * 60 * 60;

export type OssObjectInfo = {
  contentLength: number;
  contentType: string;
  metadata: Readonly<Record<string, string>>;
};

export async function putOssObject(input: {
  body: Uint8Array;
  contentType: string;
  objectKey: string;
}): Promise<void> {
  const config = readConfig();
  const response = await signedRequest(config, input.objectKey, {
    body: input.body,
    contentType: input.contentType,
    method: "PUT",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`OSS 上传对象失败：HTTP ${response.status}`);
  }
}

export async function putOssStream(input: {
  body: ReadableStream<Uint8Array>;
  cacheControl?: string;
  contentType: string;
  contentLength?: number;
  metadata?: Readonly<Record<string, string>>;
  objectKey: string;
}): Promise<void> {
  const response = await signedRequest(readConfig(), input.objectKey, {
    body: input.body,
    cacheControl: input.cacheControl,
    contentLength: input.contentLength,
    contentType: input.contentType,
    metadata: input.metadata,
    method: "PUT",
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`OSS 上传对象失败：HTTP ${response.status}`);
}

export async function deleteOssObjects(objectKeys: readonly string[]): Promise<void> {
  await Promise.allSettled(objectKeys.map(async (objectKey) => {
    const response = await signedRequest(readConfig(), objectKey, { method: "DELETE" });
    await response.body?.cancel();
  }));
}

export async function ossObjectExists(objectKey: string): Promise<boolean> {
  const response = await signedRequest(readConfig(), objectKey, { method: "HEAD" });
  await response.body?.cancel();
  return response.ok;
}

export async function getOssObjectInfo(objectKey: string): Promise<OssObjectInfo | null> {
  const response = await signedRequest(readConfig(), objectKey, { method: "HEAD" });
  await response.body?.cancel();
  if (!response.ok) return null;
  return {
    contentLength: Number(response.headers.get("content-length")) || 0,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    metadata: Object.fromEntries(
      [...response.headers.entries()]
        .filter(([name]) => name.startsWith("x-oss-meta-"))
        .map(([name, value]) => [name.slice("x-oss-meta-".length), value]),
    ),
  };
}

export function buildPublicOssObjectUrl(input: { bucket: string; objectKey: string }): string {
  const bucket = input.bucket.trim();
  if (!bucket) throw new Error("ALI_OSS_PUBLIC_BUCKET 未配置。");
  const endpoint = normalizeEndpoint(required("ALI_OSS_ENDPOINT"), bucket);
  return `${endpoint}/${encodeObjectKey(input.objectKey)}`;
}

export type OssSignedUrl = {
  expiresAt: number;
  url: string;
};

export function createOssSignedUrl(objectKey: string): string {
  return createOssSignedUrlWithExpiration(objectKey).url;
}

export function createOssSignedUrlWithExpiration(objectKey: string): OssSignedUrl {
  const config = readConfig();
  const expires = Math.floor(Date.now() / 1000) + config.signedUrlExpiresSeconds;
  const signature = sign(
    config.accessKeySecret,
    ["GET", "", "", String(expires), resource(config.bucket, objectKey)].join("\n"),
  );
  const url = new URL(objectUrl(config, objectKey));
  url.searchParams.set("OSSAccessKeyId", config.accessKeyId);
  url.searchParams.set("Expires", String(expires));
  url.searchParams.set("Signature", signature);
  return { expiresAt: expires * 1_000, url: url.toString() };
}

async function signedRequest(
  config: OssConfig,
  objectKey: string,
  input: {
    body?: Uint8Array | ReadableStream<Uint8Array>;
    cacheControl?: string;
    contentLength?: number;
    contentType?: string;
    metadata?: Readonly<Record<string, string>>;
    method: "PUT" | "DELETE" | "HEAD";
  },
): Promise<Response> {
  const date = new Date().toUTCString();
  const contentType = input.contentType ?? "";
  const metadataHeaders = Object.fromEntries(
    Object.entries(input.metadata ?? {}).map(([name, value]) => [
      `x-oss-meta-${name.trim().toLowerCase()}`,
      value.trim(),
    ]),
  );
  const canonicalizedOssHeaders = Object.entries(metadataHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const authorization = `OSS ${config.accessKeyId}:${sign(config.accessKeySecret, [
    input.method,
    "",
    contentType,
    date,
    `${canonicalizedOssHeaders}${resource(config.bucket, objectKey)}`,
  ].join("\n"))}`;
  const response = await fetchWithRetry(objectUrl(config, objectKey), {
    body: input.body as BodyInit | undefined,
    cache: input.method === "HEAD" ? "no-store" : undefined,
    headers: {
      authorization,
      date,
      ...metadataHeaders,
      ...(input.contentLength !== undefined ? { "content-length": String(input.contentLength) } :
        input.body instanceof Uint8Array ? { "content-length": String(input.body.byteLength) } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
      ...(input.cacheControl ? { "cache-control": input.cacheControl } : {}),
    },
    method: input.method,
    retry: {
      attempts: input.body instanceof ReadableStream ? 1 : undefined,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
    ...(input.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  });
  if (isRetryableHttpStatus(response.status)) {
    await response.body?.cancel();
    throw new NetworkRetryExhaustedError({ cause: new Error(`HTTP ${response.status}`) });
  }
  return response;
}

function readConfig(): OssConfig {
  const bucket = required("ALI_OSS_BUCKET");
  const endpoint = normalizeEndpoint(required("ALI_OSS_ENDPOINT"), bucket);
  return {
    accessKeyId: required("ALI_OSS_ACCESS_KEY_ID"),
    accessKeySecret: required("ALI_OSS_ACCESS_KEY_SECRET"),
    bucket,
    endpoint,
    signedUrlExpiresSeconds: positiveInteger(
      process.env.ALI_OSS_SIGNED_URL_EXPIRES_SECONDS,
      DEFAULT_SIGNED_URL_EXPIRES_SECONDS,
    ),
  };
}

function objectUrl(config: OssConfig, objectKey: string): string {
  return `${config.endpoint}/${encodeObjectKey(objectKey)}`;
}

function encodeObjectKey(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function resource(bucket: string, objectKey: string): string {
  return `/${bucket}/${objectKey}`;
}

function normalizeEndpoint(value: string, bucket: string): string {
  const url = new URL(value.startsWith("http") ? value : `https://${value}`);
  if (!url.hostname.startsWith(`${bucket}.`)) url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置。`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sign(secret: string, value: string): string {
  return createHmac("sha1", secret).update(value).digest("base64");
}
