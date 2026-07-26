import { describe, expect, it } from "vitest";
import { buildPublicOssObjectUrl } from "@/lib/oss/object-store";

describe("OSS object URLs", () => {
  it("builds a public object URL", () => {
    process.env.ALI_OSS_ENDPOINT = "https://oss-cn-test.aliyuncs.com";
    expect(buildPublicOssObjectUrl({
      bucket: "echolens-public",
      objectKey: "echolens/tests/api-key-probe.m4a",
    })).toBe("https://echolens-public.oss-cn-test.aliyuncs.com/echolens/tests/api-key-probe.m4a");
  });
});