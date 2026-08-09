const DEFAULT_BASE_URL = "http://localhost:3000";

export class EchoLensClientError extends Error {
  constructor(message, { code, status, payload } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

export function createEchoLensClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.ECHOLENS_BASE_URL ?? DEFAULT_BASE_URL);
  const token = options.token ?? process.env.ECHOLENS_API_TOKEN;
  if (!token) {
    throw new EchoLensClientError("缺少 ECHOLENS_API_TOKEN。请先在 EchoLens 设置页创建 API 访问令牌。", {
      code: "ECHOLENS_TOKEN_MISSING",
      status: 401,
    });
  }

  const requestJson = async (method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      throw new EchoLensClientError(payload?.error || `EchoLens 请求失败：${response.status}`, {
        code: payload?.code,
        status: response.status,
        payload,
      });
    }
    return payload;
  };

  return {
    resolveMedia: (input) => requestJson("POST", "/api/open/media/resolve", input),
    transcribe: (input) => requestJson("POST", "/api/open/transcripts/transcribe", input),
  };
}

export function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}
