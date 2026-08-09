"use client";

import Link from "next/link";
import { ArrowLeft, Bot, BrainCircuit, Check, ChevronDown, CirclePlay, Copy, Music2, Server, SquareTerminal } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useState } from "react";
import { AGENT_ENVIRONMENT_VARIABLES, OPEN_API_ENDPOINTS, type OpenApiEndpoint, type OpenApiVariant } from "@/lib/open-api/spec";

type DocsSection = "api" | "mcp" | "cli" | "skill";
type DocsAnchor = "api-overview" | "api-auth" | "api-endpoints" | "mcp-overview" | "mcp-tools" | "cli-overview" | "cli-commands" | "skill-overview" | "skill-install" | "skill-template";

type NavigationItem = {
  id: DocsAnchor;
  label: string;
};

type RequestCodeExample = {
  code: string;
  language: "curl" | "Python" | "Node.js";
  syntax: "bash" | "javascript" | "python";
};

type NavigationGroup = {
  id: DocsSection;
  icon: typeof Server;
  label: string;
  items: NavigationItem[];
};

const createCurlExample = (openApiUrl: string) => `# inputs：抖音或 Bilibili 分享链接列表
curl -X POST "${openApiUrl}/media/resolve" \\
  -H "Authorization: Bearer $ECHOLENS_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"inputs":["https://v.douyin.com/example","https://b23.tv/example"]}'`;

const createMcpConfig = (baseUrl: string) => JSON.stringify({
  mcpServers: {
    echolens: {
      command: "npx",
      args: ["-y", "echolens-mcp"],
      env: {
        ECHOLENS_BASE_URL: baseUrl,
        ECHOLENS_API_TOKEN: "从设置页复制的 API 访问令牌",
      },
    },
  },
}, null, 2);

const createSkillMarkdown = () => [
  "---",
  "name: echolens-api",
  "description: >-",
  "  使用 EchoLens 解析抖音或 Bilibili 链接，并转录视频音频。",
  "  当用户需要媒体解析、音频转录、字幕提取、内容整理或摘要时启用。",
  "compatibility: 需要网络访问、ECHOLENS_BASE_URL 和 ECHOLENS_API_TOKEN。",
  "---",
  "",
  "# EchoLens API",
  "",
  "当用户提供抖音或 Bilibili 链接，并要求解析媒体信息、转录音频、提取字幕、整理笔记或生成摘要时，使用这个 Skill。",
  "",
  "## 前置配置",
  "",
  "- 从环境变量读取 `ECHOLENS_BASE_URL`，作为 EchoLens 服务根地址。",
  "- 从环境变量读取 `ECHOLENS_API_TOKEN`，作为开放 API 凭证。",
  "- 每次请求都带上 `Authorization: Bearer <token>`。",
  "- 不要在面向用户的回复里输出完整 token。",
  "- 需要更多接口细节时，查看 `${ECHOLENS_BASE_URL}/docs?section=api`。",
  "",
  "## 默认流程",
  "",
  "1. 只需要媒体信息时，调用媒体解析接口。",
  "2. 需要文本、字幕、笔记或摘要时，直接调用音频转录接口。",
  "3. 转录模型默认使用 `e2`，除非用户明确指定 `e1` 或 `e3`。",
  "4. 返回简洁结果：标题、作者、来源、转录文本和必要链接。",
  "",
  "## 请求示例",
  "",
  "媒体解析：",
  "",
  "```bash",
  "curl -X POST \"$ECHOLENS_BASE_URL/api/open/media/resolve\" \\",
  "  -H \"Authorization: Bearer $ECHOLENS_API_TOKEN\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{\"inputs\":[\"https://www.bilibili.com/video/BV...\"]}'",
  "```",
  "",
  "音频转录：",
  "",
  "```bash",
  "curl -X POST \"$ECHOLENS_BASE_URL/api/open/transcripts/transcribe\" \\",
  "  -H \"Authorization: Bearer $ECHOLENS_API_TOKEN\" \\",
  "  -H \"Content-Type: application/json\" \\",
  "  -d '{\"input\":\"https://v.douyin.com/...\",\"model\":\"e2\"}'",
  "```",
  "",
  "## 输出要求",
  "",
  "- 不要求浏览器登录或 Cookie；开放 API 只需要 token。",
  "- 不暴露完整签名 URL、长查询参数、访问令牌或其他密钥。",
  "- 不编造转录内容，只使用 API 返回结果。",
  "- 配置缺失或请求失败时，只询问继续处理所需的最小信息。",
].join("\n");

const SECTION_ALIASES: Record<string, DocsSection> = {
  api: "api",
  "api-tokens": "api",
  cli: "cli",
  mcp: "mcp",
  skill: "skill",
};

const NAVIGATION: NavigationGroup[] = [
  {
    id: "api",
    icon: Server,
    label: "常规 API",
    items: [
      { id: "api-auth", label: "认证方式" },
      { id: "api-overview", label: "快速开始" },
      { id: "api-endpoints", label: "接口列表" },
    ],
  },
  {
    id: "mcp",
    icon: Bot,
    label: "Agent MCP",
    items: [
      { id: "mcp-overview", label: "安装与配置" },
      { id: "mcp-tools", label: "可用工具" },
    ],
  },
  {
    id: "skill",
    icon: BrainCircuit,
    label: "Agent Skill",
    items: [
      { id: "skill-overview", label: "适用场景" },
      { id: "skill-install", label: "安装方式" },
      { id: "skill-template", label: "Skill 模板" },
    ],
  },
  {
    id: "cli",
    icon: SquareTerminal,
    label: "Agent CLI",
    items: [
      { id: "cli-overview", label: "环境变量" },
      { id: "cli-commands", label: "常用命令" },
    ],
  },
];

const SECTION_ANCHORS: Record<DocsSection, DocsAnchor> = {
  api: "api-auth",
  cli: "cli-overview",
  mcp: "mcp-overview",
  skill: "skill-overview",
};

export function DocsPage({ initialSection, openApiBaseUrl }: { initialSection?: string; openApiBaseUrl: string }) {
  const openApiUrl = `${openApiBaseUrl}/api/open`;
  const [activeSection, setActiveSection] = useState<DocsSection>(SECTION_ALIASES[initialSection ?? ""] ?? "api");
  const [activeAnchor, setActiveAnchor] = useState<DocsAnchor>(SECTION_ANCHORS[SECTION_ALIASES[initialSection ?? ""] ?? "api"]);

  function scrollToAnchor(anchor: DocsAnchor) {
    window.requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function selectSection(section: DocsSection) {
    const anchor = SECTION_ANCHORS[section];
    setActiveSection(section);
    setActiveAnchor(anchor);
    scrollToAnchor(anchor);
  }

  function selectAnchor(section: DocsSection, anchor: DocsAnchor) {
    setActiveSection(section);
    setActiveAnchor(anchor);
    scrollToAnchor(anchor);
  }

  const navigation = (
    <nav className="grid gap-5" aria-label="文档目录">
      {NAVIGATION.map((group) => {
        const Icon = group.icon;
        const isActive = activeSection === group.id;
        return (
          <div key={group.id} className="grid gap-1">
            <button
              type="button"
              onClick={() => selectSection(group.id)}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold transition ${isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className={`size-4 ${isActive ? "text-cyan" : ""}`} aria-hidden="true" />
              {group.label}
            </button>
            {isActive ? (
              <div className="ml-4 grid border-l border-white/10 pl-3">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectAnchor(group.id, item.id)}
                    className={`h-8 rounded-md px-2 text-left text-xs transition ${activeAnchor === item.id ? "bg-cyan/[0.1] font-semibold text-cyan" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"}`}
                    aria-current={activeAnchor === item.id ? "location" : undefined}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );

  return (
    <main className="min-h-dvh overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-20 flex h-16 items-center border-b border-white/10 bg-background/95 px-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-[88rem] items-center gap-4">
          <Link href="/" className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground" aria-label="返回首页">
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          <span className="text-base font-semibold tracking-tight">EchoLens 文档</span>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[88rem] lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-white/10 px-5 py-8 lg:block">
          <div className="sticky top-[5.5rem]">{navigation}</div>
        </aside>

        <div className="border-b border-white/10 px-4 py-3 lg:hidden">
          <details className="group">
            <summary className="cursor-pointer list-none text-sm font-semibold text-foreground">文档目录</summary>
            <div className="mt-4">{navigation}</div>
          </details>
        </div>

        <article className="min-w-0 overflow-hidden px-4 py-10 sm:px-8 lg:max-w-4xl lg:px-12 xl:px-16">
          {activeSection === "api" ? <ApiDocs baseUrl={openApiBaseUrl} openApiUrl={openApiUrl} /> : null}
          {activeSection === "mcp" ? <McpDocs baseUrl={openApiBaseUrl} /> : null}
          {activeSection === "skill" ? <SkillDocs baseUrl={openApiBaseUrl} /> : null}
          {activeSection === "cli" ? <CliDocs /> : null}
        </article>
      </div>
    </main>
  );
}

function ApiDocs({ baseUrl, openApiUrl }: { baseUrl: string; openApiUrl: string }) {
  return (
    <div className="grid gap-12">
      <DocumentIntro title="常规 API" description="使用 EchoLens Open API，将媒体解析和转录能力接入你的应用或自动化工作流。" />
      <DocSection id="api-auth" title="认证方式">
        <p>进入 <Link href="/settings?section=apiTokens" className="font-semibold text-cyan hover:underline hover:underline-offset-4">设置 / API 访问令牌</Link> 创建令牌。调用时通过 `Authorization: Bearer` 请求头传入令牌。</p>
      </DocSection>
      <DocSection id="api-overview" title="快速开始">
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold text-foreground">1. 配置连接参数</h3>
          <p><code className="text-cyan">ECHOLENS_BASE_URL</code> 是 EchoLens 服务根地址；<code className="text-cyan">ECHOLENS_API_TOKEN</code> 请替换为“认证方式”中创建的访问令牌。以下命令仅用于在终端设置这两个环境变量。</p>
        </div>
        <CodeBlock language="bash" code={`export ECHOLENS_BASE_URL="${baseUrl}"\nexport ECHOLENS_API_TOKEN="el_xxx"`} />
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold text-foreground">2. 调用媒体解析接口</h3>
          <p>选择所用语言，向 <code className="text-cyan">POST /api/open/media/resolve</code> 提交媒体链接列表。将示例中的 <code className="text-cyan">inputs</code> 替换为 1 到 10 个抖音或 Bilibili 链接；成功后将按输入顺序获得作者、封面、标题与平台下载资源。</p>
        </div>
        <RequestCodeBlock examples={[
          { language: "curl", syntax: "bash", code: createCurlExample(openApiUrl) },
          {
            language: "Python",
            syntax: "python",
            code: `import os\n\nimport requests\n\n# inputs：抖音或 Bilibili 分享链接列表\nresponse = requests.post(\n    "${openApiUrl}/media/resolve",\n    headers={"Authorization": f"Bearer {os.environ['ECHOLENS_API_TOKEN']}"},\n    json={"inputs": ["https://v.douyin.com/example", "https://b23.tv/example"]},\n)\nprint(response.json())`,
          },
          {
            language: "Node.js",
            syntax: "javascript",
            code: `// inputs：抖音或 Bilibili 分享链接列表\nconst response = await fetch("${openApiUrl}/media/resolve", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.ECHOLENS_API_TOKEN}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify({ inputs: ["https://v.douyin.com/example", "https://b23.tv/example"] }),\n});\n\nconsole.log(await response.json());`,
          },
        ]} />
      </DocSection>
      <DocSection id="api-endpoints" title="接口列表">
        <div className="grid divide-y divide-white/10 border-y border-white/10">
          {OPEN_API_ENDPOINTS.map((endpoint) => <ApiReference key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} openApiUrl={openApiUrl} />)}
        </div>
      </DocSection>
    </div>
  );
}

function ApiReference({ endpoint, openApiUrl }: { endpoint: OpenApiEndpoint; openApiUrl: string }) {
  const [language, setLanguage] = useState<"Python" | "TypeScript">("Python");
  const [variantIndex, setVariantIndex] = useState(0);
  const variant = endpoint.variants[variantIndex];
  const requestCode = createRequestExample(endpoint, variant, language, openApiUrl);

  return (
    <section className="grid gap-4 py-7 first:pt-5 last:pb-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-foreground">{endpoint.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-semibold text-cyan">{endpoint.method}</span>
          <code className="text-xs text-foreground">/api/open{endpoint.path}</code>
        </div>
      </div>
      <div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{endpoint.description}</p>
      </div>
      <div className="grid gap-3">
        <h4 className="text-sm font-semibold text-foreground">请求示例</h4>
        <div className="flex items-center justify-between gap-3 border-b border-white/10">
          <div className="flex gap-1" role="tablist" aria-label="请求语言">
            {(["Python", "TypeScript"] as const).map((item) => <button key={item} type="button" onClick={() => setLanguage(item)} className={`relative h-9 px-3 text-xs font-semibold ${language === item ? "text-cyan" : "text-muted-foreground hover:text-foreground"}`} role="tab" aria-selected={language === item}>{item}{language === item ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-cyan" /> : null}</button>)}
          </div>
          {endpoint.variants.length > 1 ? (
            <Select.Root value={String(variantIndex)} onValueChange={(value) => setVariantIndex(Number(value))}>
              <Select.Trigger className="mb-1 inline-flex h-7 min-w-24 items-center justify-between gap-2 rounded-md bg-white/[0.06] px-2 text-xs font-semibold text-foreground outline-none transition hover:bg-white/[0.1] focus-visible:ring-2 focus-visible:ring-cyan/50" aria-label={`选择平台：${variant.label}`}>
                <PlatformLabel label={variant.label} />
                <Select.Icon><ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" /></Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content position="popper" sideOffset={4} className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-white/10 bg-surface-strong p-1 shadow-xl shadow-black/40">
                  <Select.Viewport>
                    {endpoint.variants.map((item, index) => (
                      <Select.Item key={item.label} value={String(index)} className="relative flex h-8 cursor-pointer select-none items-center rounded px-7 pr-2 text-xs font-semibold text-muted-foreground outline-none data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-foreground data-[state=checked]:text-cyan">
                        <Select.ItemText><PlatformLabel label={item.label} /></Select.ItemText>
                        <Select.ItemIndicator className="absolute left-2 inline-flex items-center"><Check className="size-3.5" aria-hidden="true" /></Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          ) : null}
        </div>
        <CodeBlock code={requestCode} language={language === "Python" ? "python" : "typescript"} />
      </div>
      <div className="grid gap-3">
        <h4 className="text-sm font-semibold text-foreground">响应结构示例</h4>
        <CodeBlock code={JSON.stringify(variant.response, null, 2)} language="json" />
      </div>
    </section>
  );
}

function PlatformLabel({ label }: { label?: string }) {
  const Icon = label === "抖音" ? Music2 : CirclePlay;
  return <span className="inline-flex items-center gap-1.5"><Icon className="size-3.5 text-cyan" aria-hidden="true" />{label}</span>;
}

function createRequestExample(endpoint: OpenApiEndpoint, variant: OpenApiVariant, language: "Python" | "TypeScript", openApiUrl: string): string {
  const url = `${openApiUrl}${endpoint.path}`;
  const requestBody = variant.request ? JSON.stringify(variant.request, null, 2) : undefined;
  const commentLines = endpoint.codeComments ?? [
    `请求参数：${endpoint.requestDescription ?? "此接口不需要请求参数。"}`,
    `响应：${endpoint.responseDescription}`,
  ];
  if (language === "Python") {
    const comments = commentLines.map((line) => `# ${line}`).join("\n");
    const body = requestBody ? `,\n    json=${requestBody}` : "";
    return `${comments}\n\nimport os\n\nimport requests\n\nresponse = requests.request(\n    "${endpoint.method}",\n    "${url}",\n    headers={"Authorization": f"Bearer {os.environ['ECHOLENS_API_TOKEN']}"}${body},\n)\n\nprint(response.json())`;
  }
  const comments = commentLines.map((line) => `// ${line}`).join("\n");
  const body = requestBody ? `,\n  body: JSON.stringify(${requestBody})` : "";
  return `${comments}\n\nconst response = await fetch("${url}", {\n  method: "${endpoint.method}",\n  headers: {\n    Authorization: \`Bearer \${process.env.ECHOLENS_API_TOKEN}\`,\n    "Content-Type": "application/json",\n  }${body},\n});\n\nconsole.log(await response.json());`;
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  return (
    <SyntaxHighlighter
      language={language}
      style={vscDarkPlus}
      customStyle={{ background: "transparent", fontSize: "inherit", lineHeight: "inherit", margin: 0, maxWidth: "100%", overflowWrap: "anywhere", padding: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      wrapLongLines={true}
    >
      {code}
    </SyntaxHighlighter>
  );
}

function useCodeCopy(code: string) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  return { copied, copyCode, resetCopy: () => setCopied(false) };
}

function CopyCodeButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" onClick={onCopy} className={`absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-semibold transition ${copied ? "text-emerald-400" : "bg-white/[0.07] text-muted-foreground hover:bg-white/[0.12] hover:text-foreground"}`} aria-label={copied ? "已复制" : "复制代码"} title={copied ? "已复制" : "复制代码"}>
      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function RequestCodeBlock({ examples }: { examples: RequestCodeExample[] }) {
  const [activeLanguage, setActiveLanguage] = useState<RequestCodeExample["language"]>(examples[0].language);
  const activeExample = examples.find((example) => example.language === activeLanguage) ?? examples[0];
  const { copied, copyCode, resetCopy } = useCodeCopy(activeExample.code);

  return (
    <div className="overflow-hidden rounded-md bg-black/35">
      <div className="flex items-center gap-1 border-b border-white/10 px-2">
        {examples.map((example) => (
          <button
            key={example.language}
            type="button"
            onClick={() => { setActiveLanguage(example.language); resetCopy(); }}
            className={`relative h-10 px-3 text-xs font-semibold transition ${activeLanguage === example.language ? "text-cyan" : "text-muted-foreground hover:text-foreground"}`}
            aria-current={activeLanguage === example.language ? "page" : undefined}
          >
            {example.language}
            {activeLanguage === example.language ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-cyan" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      <div className="relative">
        <div className="overflow-hidden p-4 text-xs text-foreground"><HighlightedCode code={activeExample.code} language={activeExample.syntax} /></div>
        <CopyCodeButton copied={copied} onCopy={() => void copyCode()} />
      </div>
    </div>
  );
}

function McpDocs({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="grid gap-12">
      <DocumentIntro title="Agent MCP" description="EchoLens MCP 使用官方 TypeScript SDK 的 stdio 传输，适合 Cursor、Claude Desktop 等本地 Agent 直接启动并调用。" />
      <DocSection id="mcp-overview" title="安装与配置">
        <p>在 EchoLens 设置页创建 API 访问令牌，然后把下面配置复制到 Agent 的 MCP 配置文件。<code className="text-cyan">ECHOLENS_BASE_URL</code> 填 EchoLens 服务根地址，<code className="text-cyan">ECHOLENS_API_TOKEN</code> 填访问令牌。</p>
        <CodeBlock code={createMcpConfig(baseUrl)} language="json" />
        <p>配置后重启 Agent。Agent 会发现 <code className="text-cyan">echolens_resolve_media</code> 和 <code className="text-cyan">echolens_transcribe</code> 两个工具。</p>
      </DocSection>
      <DocSection id="mcp-tools" title="可用工具">
        <div className="grid gap-3">
          <p><code className="text-cyan">echolens_resolve_media</code>：解析抖音或 Bilibili 链接，返回媒体信息。</p>
          <p><code className="text-cyan">echolens_transcribe</code>：转录抖音或 Bilibili 视频音频，可选择转录模型。</p>
        </div>
      </DocSection>
    </div>
  );
}

function SkillDocs({ baseUrl }: { baseUrl: string }) {
  return (
    <div className="grid gap-12">
      <DocumentIntro title="Agent Skill" description="复制 EchoLens Skill 后，Agent 可直接使用开放 API 解析媒体和转录音频。" />
      <DocSection id="skill-overview" title="适用场景">
        <p>当用户提供抖音或 Bilibili 链接，并希望解析媒体信息、转录音频、提取字幕或整理文本内容时，使用这个 Skill。</p>
      </DocSection>
      <DocSection id="skill-install" title="安装方式">
        <p>在 Agent 的 Skills 目录中新建 <code className="text-cyan">echolens-api/SKILL.md</code>，复制下面模板即可使用。运行前确保环境变量已配置。</p>
        <CodeBlock language="bash" code={`export ECHOLENS_BASE_URL="${baseUrl}"\nexport ECHOLENS_API_TOKEN="el_xxx"`} />
      </DocSection>
      <DocSection id="skill-template" title="Skill 模板">
        <CodeBlock language="markdown" code={createSkillMarkdown()} />
      </DocSection>
    </div>
  );
}

function CliDocs() {
  return (
    <div className="grid gap-12">
      <DocumentIntro title="Agent CLI" description="EchoLens CLI 面向本地自动化、脚本和不支持 MCP 的 Agent；所有命令默认输出稳定 JSON，适合直接交给 Agent 读取。" />
      <DocSection id="cli-overview" title="环境变量">
        <div className="grid gap-3">
          {AGENT_ENVIRONMENT_VARIABLES.map((item) => <p key={item.name}><code className="text-cyan">{item.name}</code>：{item.description}</p>)}
        </div>
        <CodeBlock language="bash" code={`export ECHOLENS_BASE_URL="http://localhost:3000"\nexport ECHOLENS_API_TOKEN="el_xxx"`} />
      </DocSection>
      <DocSection id="cli-commands" title="常用命令">
        <p>先用 <code className="text-cyan">help</code> 检查安装，再按需执行媒体解析或转录。<code className="text-cyan">mcp config</code> 会输出可复制到 Agent 的 MCP 配置。</p>
        <CodeBlock language="bash" code={`npx -y echolens help\nnpx -y echolens media resolve --input "https://www.bilibili.com/video/BV..." --json\nnpx -y echolens transcript transcribe --input "https://v.douyin.com/..." --model e2 --json\nnpx -y echolens mcp config --base-url "$ECHOLENS_BASE_URL" --json`} />
      </DocSection>
    </div>
  );
}

function DocumentIntro({ description, title }: { description: string; title: string }) {
  return (
    <header className="border-b border-white/10 pb-8">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{title}</h1>
      <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">{description}</p>
    </header>
  );
}

function DocSection({ children, id, title }: { children: React.ReactNode; id: DocsAnchor; title: string }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-5 grid gap-4 text-sm leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

function CodeBlock({ code, language = "bash" }: { code: string; language?: "bash" | "json" | "markdown" | "python" | "typescript" }) {
  const { copied, copyCode } = useCodeCopy(code);

  return (
    <div className="relative min-w-0 max-w-full overflow-hidden">
      <div className="min-w-0 max-w-full overflow-hidden rounded-md bg-black/35 p-4 text-xs text-foreground"><HighlightedCode code={code} language={language} /></div>
      <CopyCodeButton copied={copied} onCopy={() => void copyCode()} />
    </div>
  );
}