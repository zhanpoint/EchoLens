const SIMULATED_PROGRESS_DURATION_SCALE = 0.63;

export function estimateMediaProcessingDurationSeconds(videoDurationSeconds: number | undefined): number | null {
  if (!Number.isFinite(videoDurationSeconds) || !videoDurationSeconds || videoDurationSeconds <= 0) {
    return null;
  }

  const videoSeconds = Math.max(0, videoDurationSeconds);
  const estimatedSeconds = 15 + videoSeconds * 0.016 + Math.sqrt(videoSeconds) * 0.68;
  return Math.ceil(estimatedSeconds * SIMULATED_PROGRESS_DURATION_SCALE);
}

const startedAtByKey = new Map<string, number>();

/** 进度起点归属于准备任务本身，组件重挂载（切换会话）时复用同一起点而非重新计时。 */
export function readProgressStartedAt(key: string): number {
  const existing = startedAtByKey.get(key);
  if (existing !== undefined) return existing;

  const startedAt = Date.now();
  startedAtByKey.set(key, startedAt);
  return startedAt;
}

export function clearProgressStartedAt(key: string): void {
  startedAtByKey.delete(key);
}
