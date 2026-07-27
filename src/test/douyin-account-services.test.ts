import { afterEach, describe, expect, it } from "vitest";
import {
  canUseDouyinAccountServices,
  isDouyinAccountServicesEnabled,
} from "@/lib/douyin/account-services";

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

  it("allows globally enabled users or permanently entitled users", () => {
    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "false";

    expect(canUseDouyinAccountServices({ douyinAccountServicesEnabled: true })).toBe(true);
    expect(canUseDouyinAccountServices({ douyinAccountServicesEnabled: false })).toBe(false);
    expect(canUseDouyinAccountServices({})).toBe(false);
    expect(canUseDouyinAccountServices(null)).toBe(false);

    process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED = "true";
    expect(canUseDouyinAccountServices(null)).toBe(true);
  });
});