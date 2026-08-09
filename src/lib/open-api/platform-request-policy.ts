import { createHash } from "node:crypto";

export type OpenApiPlatform = "bilibili" | "douyin";

type PlatformSchedule = {
  nextRequestAt: number;
  tail: Promise<void>;
};

type PlatformPolicyOptions = {
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const COOLDOWN_MS = 5 * 60_000;
const REQUEST_LIMITS: Record<OpenApiPlatform, { intervalMs: number; jitterMs: number }> = {
  bilibili: { intervalMs: 1_000, jitterMs: 1_000 },
  douyin: { intervalMs: 500, jitterMs: 500 },
};

export class OpenApiPlatformCooldownError extends Error {
  constructor(
    readonly platform: OpenApiPlatform,
    readonly retryAfterSeconds: number,
  ) {
    super(`${platform} 上游服务暂时限制访问，请稍后重试。`);
    this.name = "OpenApiPlatformCooldownError";
  }
}

export type OpenApiPlatformRequestPolicy = {
  beforeRequest(platform: OpenApiPlatform): Promise<void>;
  observeResponse(platform: OpenApiPlatform, response: Response): void;
  observePayload(platform: OpenApiPlatform, payload: unknown): void;
};

export type OpenApiPlatformRequestPolicyManager = {
  forUser(userId: string): OpenApiPlatformRequestPolicy;
};

export function createOpenApiPlatformRequestPolicy(
  options: PlatformPolicyOptions = {},
): OpenApiPlatformRequestPolicyManager {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? delay;
  const schedules = new Map<OpenApiPlatform, PlatformSchedule>();
  const blockedUntil = new Map<string, number>();

  function cooldownKey(platform: OpenApiPlatform, userId: string): string {
    return `${platform}:${createHash("sha256").update(userId).digest("hex")}`;
  }

  function scheduleFor(platform: OpenApiPlatform): PlatformSchedule {
    let schedule = schedules.get(platform);
    if (!schedule) {
      schedule = { nextRequestAt: 0, tail: Promise.resolve() };
      schedules.set(platform, schedule);
    }
    return schedule;
  }

  function forUser(userId: string): OpenApiPlatformRequestPolicy {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) throw new Error("Open API 请求缺少用户身份。");

    function cooldown(platform: OpenApiPlatform): OpenApiPlatformCooldownError | undefined {
      const key = cooldownKey(platform, normalizedUserId);
      const until = blockedUntil.get(key) ?? 0;
      if (until <= now()) {
        blockedUntil.delete(key);
        return undefined;
      }
      return new OpenApiPlatformCooldownError(platform, Math.ceil((until - now()) / 1_000));
    }

    function block(platform: OpenApiPlatform): never {
      blockedUntil.set(cooldownKey(platform, normalizedUserId), now() + COOLDOWN_MS);
      throw cooldown(platform)!;
    }

    return {
      async beforeRequest(platform) {
        const blocked = cooldown(platform);
        if (blocked) throw blocked;

        const schedule = scheduleFor(platform);
        const limit = REQUEST_LIMITS[platform];
        const scheduled = schedule.tail.then(async () => {
          const cooldownError = cooldown(platform);
          if (cooldownError) throw cooldownError;
          const waitMs = Math.max(0, schedule.nextRequestAt - now()) + random() * limit.jitterMs;
          if (waitMs) await sleep(waitMs);
          const delayedCooldownError = cooldown(platform);
          if (delayedCooldownError) throw delayedCooldownError;
          schedule.nextRequestAt = now() + limit.intervalMs;
        });
        schedule.tail = scheduled.catch(() => undefined);
        await scheduled;
      },
      observeResponse(platform, response) {
        if (response.status === 403) block(platform);
      },
      observePayload(platform, payload) {
        if (hasRiskSignal(payload)) block(platform);
      },
    };
  }

  return { forUser };
}

export const openApiPlatformRequestPolicy = createOpenApiPlatformRequestPolicy();

function hasRiskSignal(payload: unknown): boolean {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload) ?? "";
  return /captcha|verify|安全验证|验证码|访问过于频繁|请求过于频繁|风控|"(?:code|status_code)"\s*:\s*-?(?:412|352|10000)\b/u.test(text);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}