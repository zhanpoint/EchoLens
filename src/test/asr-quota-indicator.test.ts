import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AsrQuotaIndicator } from "@/components/asr-quota-indicator";

describe("AsrQuotaIndicator", () => {
  it("renders a subdued custom state without platform progress", () => {
    const html = renderToStaticMarkup(createElement(AsrQuotaIndicator, {
      quota: {
        configuredCustomApiKey: true,
        exhausted: false,
        limitSeconds: 18_000,
        remainingSeconds: 18_000,
      },
    }));

    expect(html).toContain("custom apikey");
    expect(html).toContain("平台无法统计剩余转录时长");
    expect(html).not.toContain("conic-gradient");
    expect(html).toContain("rgb(34 211 238 / 0.28)");
  });

  it("renders the remaining platform transcription duration and progress", () => {
    const html = renderToStaticMarkup(createElement(AsrQuotaIndicator, {
      quota: {
        configuredCustomApiKey: false,
        exhausted: false,
        limitSeconds: 18_000,
        remainingSeconds: 16_560,
      },
    }));

    expect(html).toContain("free:276 分钟");
    expect(html).toContain("conic-gradient");
  });

  it("renders explicit loading and unavailable states", () => {
    expect(renderToStaticMarkup(createElement(AsrQuotaIndicator, { quota: undefined }))).toContain("读取额度");
    expect(renderToStaticMarkup(createElement(AsrQuotaIndicator, { quota: null }))).toContain("额度暂不可用");
  });
});
