import { afterEach, describe, expect, it } from "vitest";
import {
  DouyinAccountServicesDisabledError,
  isDouyinAccountServicesEnabled,
} from "@/lib/douyin/account-services";
import { createDouyinWebClient } from "@/lib/douyin/web-client";
import { signDouyinUrl } from "@/lib/douyin/xbogus";

describe("Douyin account services switch", () => {
  afterEach(() => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
  });

  it("enables only the explicit true value", () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "TRUE";
    expect(isDouyinAccountServicesEnabled()).toBe(true);

    for (const value of ["false", "1", "yes", ""]) {
      process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = value;
      expect(isDouyinAccountServicesEnabled()).toBe(false);
    }
  });

  it("blocks Cookie processing and X-Bogus calculation when disabled", () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";
    expect(() => createDouyinWebClient("sessionid=secret")).toThrow(DouyinAccountServicesDisabledError);
    expect(() => signDouyinUrl("https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1"))
      .toThrow(DouyinAccountServicesDisabledError);
  });
});