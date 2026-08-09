import { describe, expect, it } from "vitest";
import { getOpenApiBaseUrl } from "@/lib/open-api/base-url";

describe("Open API base URL", () => {
  it("uses localhost unless PROD is explicitly true", () => {
    expect(getOpenApiBaseUrl({ PROD: "false" })).toBe("http://localhost:3000");
    expect(getOpenApiBaseUrl({})).toBe("http://localhost:3000");
  });

  it("uses the public domain in production", () => {
    expect(getOpenApiBaseUrl({ PROD: "true" })).toBe("https://echolens.dreamlog.xyz");
  });
});