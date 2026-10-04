import { AsrQuotaExceededError } from "@/lib/dashscope/asr";
import { isRetryableNetworkError } from "@/lib/http/retry";
import { OpenApiPlatformCooldownError } from "@/lib/open-api/platform-request-policy";
import { DouyinMetadataError } from "@/lib/douyin/detail";
import { DouyinApiError } from "@/lib/douyin/web-client";
import {
  claimBatchItem,
  finishItem,
  LeaseLostError,
  renewBatchLease,
} from "./db";
import {
  BatchBlockedError,
  RetryableBatchError,
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
      : 2;
  // Rebind callbacks after a module reload while retaining in-flight concurrency.
  const previous = globals.__echolensBatchWorker;
  if (previous) clearInterval(previous.timer);
  const state: WorkerState = previous ?? {
    active: 0, ticking: false,
  };
  state.timer = setInterval(() => void tick(), 2000);
  state.timer.unref();
  globals.__echolensBatchWorker = state;
  void tick();

  async function tick() {
    if (state.ticking) return;
    state.ticking = true;
    try {
      while (state.active < concurrency) {
        const item = await claimBatchItem();
        if (!item) break;
        state.active += 1;
        void run(item).finally(() => {
          state.active -= 1;
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
    const text = await transcribeBatchItem(item, controller.signal);
    controller.signal.throwIfAborted();
    await finishItem(item, { text });
  } catch (error) {
    if (controller.signal.aborted || error instanceof LeaseLostError) return;
    await finishItem(item, {
      error: error instanceof Error ? error.message : "转录失败，请重试。",
      retry:
        error instanceof RetryableBatchError || isRetryableNetworkError(error),
      pause:
        error instanceof AsrQuotaExceededError ||
        error instanceof BatchBlockedError ||
        error instanceof OpenApiPlatformCooldownError ||
        (error instanceof DouyinApiError && error.code !== "UPSTREAM_ERROR") ||
        (error instanceof DouyinMetadataError &&
          error.code !== "incomplete_metadata"),
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
