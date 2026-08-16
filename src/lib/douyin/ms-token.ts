import { randomBytes } from "node:crypto";

const F2_CONFIG_URL = "https://raw.githubusercontent.com/Johnserf-Seed/f2/main/f2/conf/conf.yaml";
const CONFIG_CACHE_MS = 60 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 15_000;

type MsTokenConfig = {
  dataType: number;
  magic: number;
  strData: string;
  ulr: number;
  url: string;
  version: number;
};

let cachedConfig: { expiresAt: number; value: MsTokenConfig } | null = null;
let pendingToken: Promise<string> | null = null;

export async function resolveMsToken(
  cookieToken: string,
  userAgent: string,
): Promise<string> {
  if (cookieToken.trim()) return cookieToken.trim();
  pendingToken ??= generateRealMsToken(userAgent)
    .catch(() => "")
    .then((token) => token || generateFallbackMsToken())
    .finally(() => {
      pendingToken = null;
    });
  return pendingToken;
}

async function generateRealMsToken(userAgent: string): Promise<string> {
  const config = await readConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      body: JSON.stringify({
        dataType: config.dataType,
        magic: config.magic,
        strData: config.strData,
        tspFromClient: Date.now(),
        ulr: config.ulr,
        version: config.version,
      }),
      cache: "no-store",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "user-agent": userAgent,
      },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return "";
    }
    return readSetCookieToken(response.headers);
  } finally {
    clearTimeout(timeout);
  }
}

async function readConfig(): Promise<MsTokenConfig> {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expiresAt > now) return cachedConfig.value;
  const response = await fetch(F2_CONFIG_URL, { cache: "no-store" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`msToken 配置请求失败：HTTP ${response.status}`);
  }
  const value = parseConfig(await response.text());
  cachedConfig = { expiresAt: now + CONFIG_CACHE_MS, value };
  return value;
}

function parseConfig(yaml: string): MsTokenConfig {
  const start = yaml.indexOf("    msToken:");
  if (start < 0) throw new Error("msToken 配置不存在");
  const lines = yaml.slice(start).split(/\r?\n/u).slice(1);
  const end = lines.findIndex((line) => /^    \S/u.test(line));
  const block = (end < 0 ? lines : lines.slice(0, end)).join("\n");
  const read = (key: string): string => {
    const value = block.match(new RegExp(`^      ${key}:\\s*(.+)$`, "mu"))?.[1]?.trim();
    if (!value) throw new Error(`msToken 配置缺少 ${key}`);
    return value.replace(/^['"]|['"]$/g, "");
  };
  return {
    dataType: Number(read("dataType")),
    magic: Number(read("magic")),
    strData: read("strData"),
    ulr: Number(read("ulr")),
    url: read("url"),
    version: Number(read("version")),
  };
}

function readSetCookieToken(headers: Headers): string {
  const values = "getSetCookie" in headers && typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie") ?? ""];
  for (const value of values) {
    const token = value.match(/(?:^|[,;]\s*)msToken=([^;,\s]+)/u)?.[1];
    if (token && (token.length === 164 || token.length === 184)) return token;
  }
  return "";
}

function generateFallbackMsToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(182);
  let token = "";
  for (const byte of bytes) token += alphabet[byte % alphabet.length];
  return `${token}==`;
}