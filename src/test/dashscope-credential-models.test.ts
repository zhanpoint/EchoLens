import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDashScopeCredential } from "@/lib/dashscope/credential-test";
import { DEFAULT_DASHSCOPE_MODELS } from "@/lib/dashscope/model-config";
beforeEach(() => {
  vi.stubEnv("ALI_OSS_PUBLIC_BUCKET", "test-bucket");
  vi.stubEnv("ALI_OSS_ENDPOINT", "https://oss-ap-southeast-1.aliyuncs.com");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it.each(["flash", "filetrans"])("reports a failed %s probe even when the other E1 model succeeds", async (failed) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.includes("/tasks/")) return Response.json({ output: { task_status: "SUCCEEDED" } });
    const body = JSON.parse(String(init?.body));
    const isFlash = path.includes("multimodal-generation");
    if ((isFlash && failed === "flash") || (!isFlash && failed === "filetrans")) return Response.json({ message: "model access denied" }, { status: 403 });
    if (isFlash) return Response.json({ output: { text: "测试音频" } });
    expect(body.input.file_urls).toHaveLength(1);
    return Response.json({ output: { task_id: "test-task" } });
  });
  const result = await testDashScopeCredential("key", DEFAULT_DASHSCOPE_MODELS, "asr");
  expect(result.ok).toBe(false); expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({ purpose: "asr", ok: false, detail: expect.stringContaining("model access denied") });
  expect(result.results[0].id).toContain("qwen-audio-3.1-asr-flash-filetrans / qwen-audio-3.1-asr-flash");
  expect(fetch).toHaveBeenCalledTimes(failed === "flash" ? 3 : 2);
});
it("reports quota exhaustion separately from model authorization", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "insufficient_quota", message: "The free quota has been exhausted." } }, { status: 403 }));
  const result = await testDashScopeCredential("key", DEFAULT_DASHSCOPE_MODELS, "translation");
  expect(result.results[0]).toMatchObject({ ok: false, detail: expect.stringContaining("免费额度已耗尽") });
});
