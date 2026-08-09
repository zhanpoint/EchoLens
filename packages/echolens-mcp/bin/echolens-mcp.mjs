#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { createEchoLensClient, EchoLensClientError } from "../../echolens-agent-client/index.mjs";

const server = new McpServer({ name: "echolens-mcp", version: "0.1.0" });
const JsonObjectSchema = z.record(z.string(), z.unknown());
let client;

registerTool(
  "echolens_resolve_media",
  "解析媒体",
  "解析抖音或 Bilibili 链接，返回媒体信息。",
  {
    input: z.string().min(1).describe("抖音或 Bilibili 分享链接/BV 号"),
  },
  async ({ input }) => getClient().resolveMedia({ inputs: [input] }),
);

registerTool(
  "echolens_transcribe",
  "转录音频",
  "转录抖音或 Bilibili 视频音频，可选择转录模型。",
  {
    input: z.string().min(1).describe("抖音或 Bilibili 分享链接/BV 号"),
    model: z.enum(["e1", "e2", "e3"]).optional().describe("转录模型档位；不传则使用 EchoLens 默认档位"),
  },
  async (input) => getClient().transcribe(input),
);

function registerTool(name, title, description, inputSchema, run) {
  server.registerTool(
    name,
    { title, description, inputSchema, outputSchema: JsonObjectSchema },
    async (input) => {
      try {
        return toolResult(await run(input));
      } catch (error) {
        return toolResult(normalizeError(error), true);
      }
    },
  );
}

function getClient() {
  client ??= createEchoLensClient();
  return client;
}

function toolResult(payload, isError = false) {
  const structuredContent = toStructuredObject(payload);
  return {
    ...(isError ? { isError: true } : {}),
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
  };
}

function toStructuredObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
}

function normalizeError(error) {
  if (error instanceof EchoLensClientError) {
    return {
      code: error.code,
      error: error.message,
      status: error.status,
      recovery: error.code === "ECHOLENS_TOKEN_MISSING"
        ? "请在 EchoLens 设置页创建 API 访问令牌，并配置 ECHOLENS_API_TOKEN。"
        : "请检查 EchoLens 服务地址、API Token 权限或请求参数。",
    };
  }
  return {
    code: "ECHOLENS_MCP_ERROR",
    error: error instanceof Error ? error.message : String(error),
    status: 500,
    recovery: "请检查 EchoLens MCP 运行环境。",
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);