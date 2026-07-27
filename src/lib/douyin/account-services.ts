const ENABLED_VALUE = "true";
type AccountServicesUser = {
  douyinAccountServicesEnabled?: boolean;
};

export const DOUYIN_ACCOUNT_SERVICES_DISABLED_CODE = "DOUYIN_ACCOUNT_SERVICES_DISABLED";
export const DOUYIN_ACCOUNT_SERVICES_DISABLED_MESSAGE = "抖音评论、收藏、关注及账号凭证服务暂时关闭。";

export function isDouyinAccountServicesEnabled(): boolean {
  return process.env.DOUYIN_ACCOUNT_SERVICES_ENABLED?.trim().toLowerCase() === ENABLED_VALUE;
}

export function canUseDouyinAccountServices(user: AccountServicesUser | null): boolean {
  return isDouyinAccountServicesEnabled() || user?.douyinAccountServicesEnabled === true;
}
