const ENABLED_VALUE = "true";

export const DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE = "DOUYIN_ACCOUNT_SERVICES_DISABLED";
export const DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE = "抖音评论、收藏、关注及账号凭证服务暂时关闭。";

export function isDouyinAccountServicesEnabled(): boolean {
  return process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED?.trim().toLowerCase() === ENABLED_VALUE;
}

export function assertDouyinAccountServicesEnabled(): void {
  if (!isDouyinAccountServicesEnabled()) {
    throw new DouyinAccountServicesDisabledError();
  }
}

export class DouyinAccountServicesDisabledError extends Error {
  readonly code = DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE;

  constructor() {
    super(DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE);
    this.name = "DouyinAccountServicesDisabledError";
  }
}