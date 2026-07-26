import { describe, expect, it } from "vitest";
import { detectDesktopPlatform, detectWindowsArchitecture } from "@/lib/client-platform";

describe("desktop platform detection", () => {
  it.each([
    ["Windows", "windows"],
    ["Win32", "windows"],
    ["macOS", "macos"],
    ["MacIntel", "macos"],
  ])("detects %s as %s", (platform, expected) => {
    expect(detectDesktopPlatform({ platform })).toBe(expected);
  });

  it("does not treat an iPad in desktop mode as macOS", () => {
    expect(detectDesktopPlatform({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
    })).toBeNull();
  });

  it("rejects unsupported desktop systems", () => {
    expect(detectDesktopPlatform({ platform: "Linux x86_64" })).toBeNull();
  });

  it.each([
    [{ architecture: "x86", bitness: "64" }, "x64"],
    [{ architecture: "arm", bitness: "64" }, "arm64"],
    [{ userAgent: "Windows NT 10.0; ARM64" }, "arm64"],
    [{ userAgent: "Windows NT 10.0; Win64; x64" }, "x64"],
  ])("selects the matching Windows binary", (input, expected) => {
    expect(detectWindowsArchitecture(input)).toBe(expected);
  });
});
