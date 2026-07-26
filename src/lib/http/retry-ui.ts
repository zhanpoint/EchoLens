import { NETWORK_RETRY_ERROR_CODE } from "@/lib/http/retry";

type StreamTextEvent =
  | { type: "delta"; value: string }
  | { type: "replace"; value?: string };

export function isNetworkRetryErrorCode(code: string | undefined): boolean {
  return code === NETWORK_RETRY_ERROR_CODE;
}

export function applyStreamTextEvent(current: string, event: StreamTextEvent): string {
  return event.type === "replace" ? event.value ?? "" : current + event.value;
}