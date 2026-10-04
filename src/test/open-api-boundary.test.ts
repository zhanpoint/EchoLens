import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenMediaResolveSchema, OpenTranscriptionSchema } from "@/lib/open-api/contracts";
import { OPEN_API_ENDPOINTS } from "@/lib/open-api/spec";

const OPEN_ROUTES_ROOT = join(process.cwd(), "src", "app", "api", "open");
const OPEN_API_LIB_ROOT = join(process.cwd(), "src", "lib", "open-api");
const FORBIDDEN_ROUTE_IMPORT = /from\s+["']@\/app\/api\/(?:douyin|media|transcript-history)\//u;
const FORBIDDEN_VIDEO_ASSET_IMPORT = /from\s+["']@\/lib\/douyin\/asset-bundle["']/u;

describe("Open API boundary", () => {
  it("keeps public routes independent from internal route modules", () => {
    for (const path of routeFiles(OPEN_ROUTES_ROOT)) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(FORBIDDEN_ROUTE_IMPORT);
      expect(source, path).not.toMatch(/export\s*\{[^}]+\}\s*from/u);
    }
  });

  it("keeps public media resolution away from private video asset preparation", () => {
    for (const path of sourceFiles(OPEN_API_LIB_ROOT)) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(FORBIDDEN_VIDEO_ASSET_IMPORT);
      expect(source, path).not.toContain("ensurePreparedAsset");
      expect(source, path).not.toContain("ossVideoUrl");
    }
  });

  it("exposes only documented routes", () => {
    expect(routeFiles(OPEN_ROUTES_ROOT).map((path) => path
      .slice(OPEN_ROUTES_ROOT.length)
      .replaceAll("\\", "/")
    ).sort()).toEqual([
      "/media/resolve/route.ts",
      "/transcripts/transcribe/route.ts",
    ]);
  });

  it("accepts only a public media link and optional model for transcription", () => {
    expect(OpenTranscriptionSchema.safeParse({
      input: "https://v.douyin.com/example",
      model: "e1",
    }).success).toBe(true);
    expect(OpenTranscriptionSchema.safeParse({
      historyRecordId: "history_123",
      model: "e1",
    }).success).toBe(false);
    expect(OpenTranscriptionSchema.safeParse({
      input: "https://v.douyin.com/example",
      clientJobId: "internal-job",
    }).success).toBe(false);
  });

  it("requires a bounded list of media links", () => {
    expect(OpenMediaResolveSchema.safeParse({
      inputs: ["https://v.douyin.com/example", "https://b23.tv/example"],
    }).success).toBe(true);
    expect(OpenMediaResolveSchema.safeParse({ input: "https://v.douyin.com/example" }).success).toBe(false);
    expect(OpenMediaResolveSchema.safeParse({ inputs: [] }).success).toBe(false);
    expect(OpenMediaResolveSchema.safeParse({ inputs: Array.from({ length: 11 }, () => "https://b23.tv/example") }).success).toBe(false);
  });

  it("keeps internal fields out of public examples", () => {
    const contract = JSON.stringify(OPEN_API_ENDPOINTS);
    for (const field of ["objectKey", "workKey", "workId", "promptId", "historyRecord", "role"]) {
      expect(contract).not.toContain(`\"${field}\"`);
    }
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}