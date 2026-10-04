import { spawn } from "node:child_process";

const STDERR_TAIL_CHARS = 8_192;
const NO_OUTPUT_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 10_000;

/** Settles only after the process and its pipes close, before callers remove temporary files. */
export async function runFfmpegProcess(input: {
  args: readonly string[];
  binary: string;
  onStderr?: (chunk: string) => void;
  operation: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  input.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.binary, ["-progress", "pipe:2", "-nostats", ...input.args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const abort = () => {
      const error = new Error("媒体处理已取消。", { cause: input.signal?.reason });
      error.name = "AbortError";
      terminate(error);
    };
    const timeout = setTimeout(() => terminate(new Error(`${input.operation}超时。`)), input.timeoutMs);
    const heartbeat = setTimeout(() => terminate(new Error(`${input.operation}无响应。`)), NO_OUTPUT_TIMEOUT_MS);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      heartbeat.refresh();
      stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
      input.onStderr?.(chunk);
    });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(heartbeat);
      clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", abort);
      if (failure) {
        reject(failure);
      } else if (code !== 0) {
        reject(new Error(`${input.operation}失败：${stderr.slice(-600) || `ffmpeg exited with code ${code}`}`));
      } else {
        resolve();
      }
    });
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
  });
}
