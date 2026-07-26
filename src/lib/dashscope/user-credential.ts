import {
  normalizeDashScopeModelIds,
  readEnvironmentDashScopeModelIds,
  type EchoLensDashScopeModelIds,
} from "@/lib/dashscope/model-config";
import { readUserSetting } from "@/lib/user-settings";

type AiCredentialSetting = {
  apiKey?: unknown;
};

export type DashScopeUserConfig = {
  apiKey?: string;
  customApiKey?: string;
  customModels: EchoLensDashScopeModelIds;
  isCustomApiKey: boolean;
  models: EchoLensDashScopeModelIds;
  platformApiKey?: string;
  platformModels: EchoLensDashScopeModelIds;
};

export async function readDashScopeUserConfig(userId: string): Promise<DashScopeUserConfig> {
  const platformApiKey = normalizeApiKey(process.env.DASHSCOPE_API_KEY);
  const platformModels = readEnvironmentDashScopeModelIds();
  if (!process.env.DATABASE_URL?.trim()) {
    return {
      apiKey: platformApiKey,
      customModels: normalizeDashScopeModelIds(undefined),
      isCustomApiKey: false,
      models: platformModels,
      platformApiKey,
      platformModels,
    };
  }

  const [credential, modelSetting] = await Promise.all([
    readUserSetting(userId, "aiCredential") as Promise<AiCredentialSetting | undefined>,
    readUserSetting(userId, "aiModels"),
  ]);
  const customApiKey = normalizeApiKey(credential?.apiKey);
  const customModels = normalizeDashScopeModelIds(modelSetting);
  return {
    apiKey: customApiKey || platformApiKey,
    customApiKey,
    customModels,
    isCustomApiKey: Boolean(customApiKey),
    models: customApiKey ? customModels : platformModels,
    platformApiKey,
    platformModels,
  };
}

export async function readDashScopeApiKeyForUser(userId: string): Promise<string | undefined> {
  if (!process.env.DATABASE_URL?.trim()) {
    return normalizeApiKey(process.env.DASHSCOPE_API_KEY);
  }
  const credential = await readUserSetting(userId, "aiCredential") as AiCredentialSetting | undefined;
  return normalizeApiKey(credential?.apiKey) || normalizeApiKey(process.env.DASHSCOPE_API_KEY);
}

function normalizeApiKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
