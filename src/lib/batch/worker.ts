import { AsrQuotaExceededError } from "@/lib/dashscope/asr";
import { OpenApiPlatformCooldownError } from "@/lib/open-api/platform-request-policy";
import { DouyinMetadataError } from "@/lib/douyin/detail";
import { DouyinApiError } from "@/lib/douyin/web-client";
import {
  claimBatchItem,
  finishItem,
  LeaseLostError,
  renewBatchLease,
  recoverBatchQueue,
} from "./db";
import {
  BatchBlockedError,
  transcribeBatchItem,
} from "./transcribe";

type WorkerState = {
  active: number;
  timer?: ReturnType<typeof setInterval>;
  ticking: boolean;
};
const globals = globalThis as typeof globalThis & {
  __echolensBatchWorker?: WorkerState;
};

export function startBatchWorker(): void {
  if (!process.env.POSTGRES_PASSWORD) return;
  const configured = Number(process.env.BATCH_TRANSCRIBE_CONCURRENCY);
  const concurrency =
    Number.isInteger(configured) && configured > 0
      ? Math.min(8, configured)
      : 4;
  // Rebind callbacks after a module reload while retaining in-flight concurrency.
  const previous = globals.__echolensBatchWorker;
  if (previous) clearInterval(previous.timer);
  const state: WorkerState = previous ?? {
    active: 0, ticking: false,
  };
  state.timer = setInterval(() => void tick(), 1000);
  state.timer.unref();
  globals.__echolensBatchWorker = state;
  void recoverBatchQueue().then(tick).catch(error => console.error("[batch.worker] 恢复任务队列失败", error));

  async function tick() {
    if (state.ticking) return;
    state.ticking = true;
    try {
      while (state.active < concurrency) {
        const item = await claimBatchItem(concurrency * 2);
        if (!item) break;
        state.active += 1;
        void run(item).finally(() => {
          state.active -= 1;
          void tick();
        });
      }
    } catch (error) {
      console.error(
        "[batch.worker] 无法读取任务队列",
        error instanceof Error ? error.message : error,
      );
    } finally {
      state.ticking = false;
    }
  }
}

async function run(
  item: NonNullable<Awaited<ReturnType<typeof claimBatchItem>>>,
) {
  const controller = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewBatchLease(item)
      .then(
        (owned) => {
          if (!owned) controller.abort(new LeaseLostError());
        },
        () => controller.abort(new LeaseLostError()),
      )
      .finally(() => {
        renewing = false;
      });
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await transcribeBatchItem(item, controller.signal);
    controller.signal.throwIfAborted();
    await finishItem(item, typeof result === "string" ? { text: result } : result);
  } catch (error) {
    if (controller.signal.aborted || error instanceof LeaseLostError) return;
    const pause = error instanceof AsrQuotaExceededError ||
      error instanceof BatchBlockedError ||
      (error instanceof DouyinApiError && error.code !== "UPSTREAM_ERROR" && error.code !== "RATE_LIMITED") ||
      (error instanceof DouyinMetadataError && error.code !== "incomplete_metadata");
    const retryAfterMs = error instanceof OpenApiPlatformCooldownError
      ? error.retryAfterSeconds * 1000
      : error instanceof DouyinApiError && error.code === "RATE_LIMITED"
        ? (error.details?.retryAfterSeconds ?? 300) * 1000 : undefined;
    await finishItem(item, {
      error: error instanceof Error ? error.message : "转录失败，请重试。",
      retry: !pause,
      pause,
      ...(retryAfterMs ? { retryAfterMs } : {}),
    }).catch((failure) =>
      console.error(
        "[batch.worker] 保存任务状态失败",
        failure instanceof Error ? failure.message : failure,
      ),
    );
  } finally {
    clearInterval(heartbeat);
  }
}
