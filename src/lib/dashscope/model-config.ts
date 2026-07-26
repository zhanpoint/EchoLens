const CHAT_MODEL_OPTIONS = [
  "deepseek-v4-flash",
  "qwen3.7-plus",
  "qwen3.7-plus-2026-05-26",
  "qwen3.6-plus",
  "qwen3.6-plus-2026-04-02",
  "qwen3.5-plus",
  "qwen3.5-plus-2026-02-15",
  "qwen3.5-flash",
  "qwen3.5-flash-2026-02-23",
] as const;

export const DASHSCOPE_MODEL_OPTIONS = {
  asrE1: [
    "qwen3-asr-flash-filetrans",
    "qwen3-asr-flash-filetrans-2025-11-17",
  ],
  asrE2: [
    "fun-asr",
    "fun-asr-2025-11-07",
    "fun-asr-2025-08-25",
  ],
  translation: [
    "qwen-mt-flash",
    "qwen-mt-plus",
    "qwen-mt-turbo",
  ],
  transcriptPostprocess: CHAT_MODEL_OPTIONS,
  summary: CHAT_MODEL_OPTIONS,
} as const;

export type DashScopeModelPurpose = keyof typeof DASHSCOPE_MODEL_OPTIONS;
export type DashScopeModelId<Purpose extends DashScopeModelPurpose = DashScopeModelPurpose> =
  (typeof DASHSCOPE_MODEL_OPTIONS)[Purpose][number];

export type EchoLensDashScopeModelIds = Record<DashScopeModelPurpose, string>;

export const DEFAULT_DASHSCOPE_MODELS: EchoLensDashScopeModelIds = {
  asrE1: "qwen3-asr-flash-filetrans",
  asrE2: "fun-asr",
  translation: "qwen-mt-flash",
  transcriptPostprocess: "deepseek-v4-flash",
  summary: "deepseek-v4-flash",
};

export function readEnvironmentDashScopeModelIds(): EchoLensDashScopeModelIds {
  return {
    asrE1: readRequiredEnv("DASHSCOPE_ASR_MODEL_E1"),
    asrE2: readRequiredEnv("DASHSCOPE_ASR_MODEL_E2"),
    translation: readRequiredEnv("DASHSCOPE_TRANSLATION_MODEL"),
    transcriptPostprocess: readRequiredEnv("DASHSCOPE_TRANSCRIPT_POSTPROCESS_MODEL"),
    summary: readRequiredEnv("DASHSCOPE_SUMMARY_MODEL"),
  };
}

export const DASHSCOPE_MODEL_METADATA: Record<DashScopeModelPurpose, { label: string }> = {
  asrE1: { label: "E1 模型" },
  asrE2: { label: "E2 模型" },
  translation: { label: "翻译模型" },
  transcriptPostprocess: { label: "转录后处理模型" },
  summary: { label: "AI 总结模型" },
};

export function isDashScopeModelId<Purpose extends DashScopeModelPurpose>(
  purpose: Purpose,
  value: unknown,
): value is DashScopeModelId<Purpose> {
  return typeof value === "string" && (DASHSCOPE_MODEL_OPTIONS[purpose] as readonly string[]).includes(value);
}

export function normalizeDashScopeModelIds(value: unknown): EchoLensDashScopeModelIds {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    (Object.keys(DEFAULT_DASHSCOPE_MODELS) as DashScopeModelPurpose[]).map((purpose) => [
      purpose,
      isDashScopeModelId(purpose, input[purpose]) ? input[purpose] : DEFAULT_DASHSCOPE_MODELS[purpose],
    ]),
  ) as EchoLensDashScopeModelIds;
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置。`);
  }
  return value;
}
