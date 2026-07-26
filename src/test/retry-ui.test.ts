import { describe, expect, it } from "vitest";
import { NETWORK_RETRY_ERROR_CODE } from "@/lib/http/retry";
import { applyStreamTextEvent, isNetworkRetryErrorCode } from "@/lib/http/retry-ui";

describe("retry UI contract", () => {
  it("only exposes retry for the unified network error code", () => {
    expect(isNetworkRetryErrorCode(NETWORK_RETRY_ERROR_CODE)).toBe(true);
    expect(isNetworkRetryErrorCode("UPSTREAM_ERROR")).toBe(false);
    expect(isNetworkRetryErrorCode(undefined)).toBe(false);
  });

  it("appends deltas and replaces output on stream reset", () => {
    expect(applyStreamTextEvent("第一段", { type: "delta", value: "第二段" })).toBe("第一段第二段");
    expect(applyStreamTextEvent("失败尝试的部分内容", { type: "replace", value: "" })).toBe("");
  });
});