import { createVerify, X509Certificate } from "node:crypto";
import { NextResponse } from "next/server";
import { handleDashScopeAsrCallback } from "@/lib/dashscope/asr";
import { fetchWithRetry } from "@/lib/http/retry";
import { isProdRuntime } from "@/lib/runtime";

export const runtime = "nodejs";

const EVENTBRIDGE_SIGNATURE_TTL_MS = 60_000;
const EVENTBRIDGE_CERT_HOST_PATTERN = /^[a-z0-9-]+-eventbridge\.oss-accelerate\.aliyuncs\.com$/i;
const EVENTBRIDGE_SIGNATURE_HEADERS = [
  "x-eventbridge-signature-timestamp",
  "x-eventbridge-hash-method",
  "x-eventbridge-signature-version",
  "x-eventbridge-signature-url",
  "x-eventbridge-signature-token",
];

export async function POST(request: Request) {
  if (!isProdRuntime()) {
    return NextResponse.json({ error: "本地测试环境仅使用主动轮询，不接收 EventBridge 回调。" }, { status: 404 });
  }

  const body = await request.text();
  const verified = await verifyEventBridgeSignature(request, body);
  if (!verified.ok) {
    console.warn("[dashscope-asr-callback] rejected EventBridge request", {
      error: verified.error,
      hasSignature: Boolean(request.headers.get("x-eventbridge-signature-v2")),
      publicUrl: readPublicRequestUrl(request),
      requestUrl: request.url,
      signatureUrl: request.headers.get("x-eventbridge-signature-url"),
      timestamp: request.headers.get("x-eventbridge-signature-timestamp"),
    });
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  const payload = parseJsonObject(body);
  const taskId = readStringPath(payload, ["data", "task_id"]);
  const source = readStringPath(payload, ["source"]);
  const type = readStringPath(payload, ["type"]);
  const taskStatus = readStringPath(payload, ["data", "task_status"]);
  if (!taskId) {
    console.warn("[dashscope-asr-callback] missing DashScope task_id", {
      source,
      type,
      taskStatus,
    });
    return NextResponse.json({ error: "缺少 DashScope task_id。" }, { status: 400 });
  }

  const result = await handleDashScopeAsrCallback(taskId, payload);
  console.info("[dashscope-asr-callback] processed DashScope event", {
    resultStatus: result?.status ?? "not_found",
    source,
    taskId,
    taskStatus,
    type,
  });
  return NextResponse.json({ ok: true });
}

async function verifyEventBridgeSignature(
  request: Request,
  body: string,
): Promise<{ ok: true } | { error: string; ok: false }> {
  const signature = request.headers.get("x-eventbridge-signature-v2")?.trim();
  const hashMethod = request.headers.get("x-eventbridge-hash-method")?.trim();
  const publicKeyUrl = request.headers.get("x-eventbridge-signature-url")?.trim();
  const timestamp = request.headers.get("x-eventbridge-signature-timestamp")?.trim();
  if (!signature || !hashMethod || !publicKeyUrl || !timestamp) {
    return { ok: false, error: "缺少 EventBridge 签名请求头。" };
  }
  if (hashMethod.toUpperCase() !== "SHA256") {
    return { ok: false, error: "EventBridge 签名哈希算法不支持。" };
  }

  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > EVENTBRIDGE_SIGNATURE_TTL_MS) {
    return { ok: false, error: "EventBridge 签名时间戳无效。" };
  }

  const certUrl = parseTrustedCertificateUrl(publicKeyUrl);
  if (!certUrl) {
    return { ok: false, error: "EventBridge 证书地址不可信。" };
  }

  try {
    const certificate = await fetchEventBridgeCertificate(certUrl);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(buildEventBridgeStringToSign(request, body));
    verifier.end();
    return verifier.verify(certificate.publicKey, Buffer.from(signature, "base64"))
      ? { ok: true }
      : { ok: false, error: "EventBridge 签名校验失败。" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "EventBridge 签名校验失败。",
    };
  }
}

function buildEventBridgeStringToSign(request: Request, body: string): string {
  const signedHeaders = EVENTBRIDGE_SIGNATURE_HEADERS
    .map((header) => {
      const value = request.headers.get(header)?.trim();
      return value ? `${header}: ${value}` : null;
    })
    .filter((line): line is string => Boolean(line));

  return `${readPublicRequestUrl(request)}\n${signedHeaders.join("\n")}\n${body}`;
}

function readPublicRequestUrl(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = readForwardedHeader(request, "x-forwarded-proto");
  const forwardedHost = readForwardedHeader(request, "x-forwarded-host");
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (forwardedProto) {
    url.protocol = `${forwardedProto.replace(/:$/, "")}:`;
  }
  if (host) {
    url.host = host;
  }

  return url.toString();
}

function readForwardedHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.split(",")[0]?.trim() ?? "";
  return value;
}

function parseTrustedCertificateUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && EVENTBRIDGE_CERT_HOST_PATTERN.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

async function fetchEventBridgeCertificate(url: URL): Promise<X509Certificate> {
  const response = await fetchWithRetry(url.toString(), {
    cache: "force-cache",
    retry: { attempts: 2, timeoutMs: 5_000 },
  });
  if (!response.ok) {
    throw new Error(`EventBridge 证书下载失败：HTTP ${response.status}`);
  }

  return new X509Certificate(await response.text());
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function readStringPath(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.trim() ? current.trim() : null;
}
