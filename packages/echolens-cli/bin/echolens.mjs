#!/usr/bin/env node
import { createEchoLensClient, EchoLensClientError, normalizeBaseUrl } from "../../echolens-agent-client/index.mjs";

const args = process.argv.slice(2);
const flags = readFlags(args);
const [scope, action, ...rest] = flags.positionals;

try {
  const result = await runCommand(scope, action, rest, flags);
  if (result !== undefined) printResult(result);
} catch (error) {
  const normalized = normalizeError(error);
  const message = JSON.stringify(normalized, null, 2);
  if (flags.json) console.error(message);
  else {
    console.error(`EchoLens 错误：${normalized.error}`);
    if (normalized.recovery) console.error(normalized.recovery);
  }
  process.exit(normalized.status && normalized.status >= 500 ? 2 : 1);
}

async function runCommand(scope, action, rest, flags) {
  if (!scope || scope === "help" || flags.help) return help();
  if (scope === "mcp" && action === "config") return mcpConfig(flags);

  const client = createEchoLensClient({ baseUrl: flags.baseUrl, token: flags.token });
  if (scope === "media" && action === "resolve") {
    return client.resolveMedia({ inputs: [required(readOption(rest, "--input") ?? rest[0], "缺少 --input。")] });
  }
  if (scope === "transcript" && action === "transcribe") {
    const model = readOption(rest, "--model");
    if (model && model !== "e1") {
      throw new EchoLensClientError("--model 仅支持 e1。", {
        code: "ECHOLENS_CLI_INVALID_INPUT",
        status: 400,
      });
    }
    return await client.transcribe({
      input: required(readOption(rest, "--input") ?? rest[0], "缺少 --input。"),
      ...(model ? { model } : {}),
    });
  }
  throw new EchoLensClientError(`未知命令：${[scope, action].filter(Boolean).join(" ")}`, {
    code: "ECHOLENS_CLI_UNKNOWN_COMMAND",
    status: 400,
  });
}

function mcpConfig(flags) {
  return {
    mcpServers: {
      echolens: {
        command: "npx",
        args: ["-y", "echolens-mcp"],
        env: {
          ECHOLENS_BASE_URL: normalizeBaseUrl(flags.baseUrl ?? process.env.ECHOLENS_BASE_URL ?? "http://localhost:3000"),
          ECHOLENS_API_TOKEN: "<从 EchoLens 设置页复制的 API 访问令牌>",
        },
      },
    },
  };
}

function readFlags(rawArgs) {
  const flags = { json: false, positionals: [] };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (value === "--json") flags.json = true;
    else if (value === "--help" || value === "-h") flags.help = true;
    else if (value === "--base-url") flags.baseUrl = requiredFlagValue(rawArgs, ++index, "--base-url");
    else if (value === "--token") flags.token = requiredFlagValue(rawArgs, ++index, "--token");
    else flags.positionals.push(value);
  }
  return flags;
}

function readOption(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? requiredFlagValue(values, index + 1, name) : undefined;
}

function requiredFlagValue(values, index, name) {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new EchoLensClientError(`${name} 缺少参数值。`, {
      code: "ECHOLENS_CLI_INVALID_INPUT",
      status: 400,
    });
  }
  return value;
}

function required(value, message) {
  if (!value) throw new EchoLensClientError(message, { code: "ECHOLENS_CLI_INVALID_INPUT", status: 400 });
  return value;
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function normalizeError(error) {
  if (error instanceof EchoLensClientError) {
    return {
      code: error.code,
      error: error.message,
      status: error.status,
      ...(error.code === "ECHOLENS_TOKEN_MISSING"
        ? { recovery: "请在设置页创建 API 访问令牌，并设置 ECHOLENS_API_TOKEN。" }
        : {}),
    };
  }
  return { code: "ECHOLENS_CLI_ERROR", error: error instanceof Error ? error.message : String(error), status: 500 };
}

function help() {
  return {
    env: {
      ECHOLENS_BASE_URL: "EchoLens 服务根地址，例如 http://localhost:3000",
      ECHOLENS_API_TOKEN: "设置页创建的 API 访问令牌",
    },
    commands: [
      "echolens media resolve --input <url-or-bv> --json",
      "echolens transcript transcribe --input <url-or-bv> --model e1 --json",
      "echolens mcp config --base-url http://localhost:3000 --json",
    ],
  };
}