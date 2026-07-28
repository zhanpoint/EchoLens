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
        limitSeconds: 3_600,
        remainingSeconds: 3_600,
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
        limitSeconds: 3_600,
        remainingSeconds: 2_160,
      },
    }));

    expect(html).toContain("free:36 分钟");
    expect(html).toContain("conic-gradient");
  });

  it("renders explicit loading and unavailable states", () => {
    expect(renderToStaticMarkup(createElement(AsrQuotaIndicator, { quota: undefined }))).toContain("读取额度");
    expect(renderToStaticMarkup(createElement(AsrQuotaIndicator, { quota: null }))).toContain("额度暂不可用");
  });
});
