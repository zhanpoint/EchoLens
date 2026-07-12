export type SupportedDesktopPlatform = "macos" | "windows";
export type WindowsArchitecture = "arm64" | "x64";

export function detectDesktopPlatform(input: {
  platform?: string;
  userAgent?: string;
}): SupportedDesktopPlatform | null {
  const userAgent = input.userAgent ?? "";
  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return null;
  }

  const platform = input.platform || userAgent;
  if (/mac/i.test(platform)) {
    return "macos";
  }
  if (/win/i.test(platform)) {
    return "windows";
  }
  return null;
}

export function detectWindowsArchitecture(input: {
  architecture?: string;
  bitness?: string;
  userAgent?: string;
}): WindowsArchitecture {
  const architecture = `${input.architecture ?? ""} ${input.userAgent ?? ""}`;
  if (/arm64|aarch64/i.test(architecture) || (/\barm\b/i.test(architecture) && input.bitness === "64")) {
    return "arm64";
  }
  return "x64";
}
