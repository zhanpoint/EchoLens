import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "法律声明 | EchoLens",
  description: "EchoLens 法律声明、版权合规和使用限制",
};

const sections = [
  {
    id: "purpose",
    title: "工具初衷",
    body: [
      "EchoLens 的初衷是帮助用户快速理解抖音上优质、有价值的视频内容。工具通过 AI 辅助整理公开可访问的信息，如文字描述、关键观点和内容线索，并结合 AI 洞察分析作品传达的核心价值和启发，帮助用户更好地思考、学习和内化知识。",
      "EchoLens 不是抖音或字节跳动的官方产品，也不代表已获得平台、作者或第三方权利人的授权。用户仍需自行遵守抖音平台规则和相关法律法规。",
      "本工具禁止将他人作品用于搬运、转载、售卖、批量复制或其他侵犯权利人合法权益的用途。",
    ],
  },
  {
    id: "copyright",
    title: "版权合规",
    body: [
      "抖音作品可能包含视频、音频、图片、文字、字幕、配乐、肖像、商标等多类受保护内容，相关权利可能归属于原作者、平台、音乐权利人或其他第三方。",
      "用户在使用本工具前，应确认自己对输入的作品链接和后续使用方式拥有合法授权，或该使用属于法律法规允许的合理范围。用户应优先通过抖音平台官方方式观看完整内容，并尊重原创作者和平台规则。",
      "如权利人认为相关内容或使用方式侵犯其合法权益，可以联系网站运营方处理，邮箱：2201609540@qq.com。收到有效通知后，我们将第一时间根据实际情况采取限制、删除或停止相关功能等措施。",
    ],
  },
  {
    id: "usage",
    title: "使用限制",
    body: [
      "用户仅可将本工具用于个人学习、研究、评论、信息整理和非商业场景，不得用于侵犯著作权、信息网络传播权、复制权、改编权、肖像权、商标权或其他第三方权益。",
      "禁止使用本工具进行批量抓取、平台规避、账号滥用、内容搬运、生成侵权素材库、商业转售、未经授权的二次分发，或其他违反法律法规、平台协议和公序良俗的行为。",
      "如果用户将提取或分析结果用于公开发布、商业经营、培训课程、素材分发、账号运营或其他对外传播场景，应自行取得必要授权并承担相应法律责任。",
    ],
  },
  {
    id: "responsibility",
    title: "责任说明",
    body: [
      "用户应对自己输入的链接、选择的功能、生成结果的保存和后续使用承担责任。EchoLens 无法逐一核验每个作品的权属状态，也无法替用户判断具体使用是否已经取得充分授权。",
      "本页面内容仅用于说明网站使用规则和合规边界，不构成正式法律意见。如涉及上线运营、商业化、版权投诉或平台合作，请咨询专业律师。",
    ],
  },
];

export default function LegalPage() {
  return (
    <main className="app-shell min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:px-5 sm:py-8 md:py-12">
        <header className="rounded-lg border border-white/15 bg-black/20 p-5 sm:p-6">
          <Link className="text-sm font-semibold text-cyan transition hover:text-amber" href="/">
            返回首页
          </Link>
          <h1 className="mt-5 text-2xl font-semibold text-foreground sm:text-3xl">法律声明</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            请在使用 EchoLens 前阅读本声明。继续使用本工具，即表示你确认将遵守法律法规、平台规则和本页面列明的使用限制。
          </p>
        </header>

        <div className="grid gap-4">
          {sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-6 rounded-lg border border-white/15 bg-black/20 p-5 sm:p-6"
            >
              <h2 className="text-lg font-semibold text-foreground">{section.title}</h2>
              <div className="mt-4 grid gap-3 text-sm leading-6 text-muted-foreground">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
