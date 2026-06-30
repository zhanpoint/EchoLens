export function estimateMediaProcessingDurationSeconds(videoDurationSeconds: number | undefined): number | null {
  if (!Number.isFinite(videoDurationSeconds) || !videoDurationSeconds || videoDurationSeconds <= 0) {
    return null;
  }

  const videoSeconds = Math.max(0, videoDurationSeconds);
  const estimatedSeconds = 15 + videoSeconds * 0.016 + Math.sqrt(videoSeconds) * 0.68;
  return Math.ceil(estimatedSeconds);
}
