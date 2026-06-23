import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "法律声明 | EchoLens",
  description: "EchoLens 法律声明、使用边界、版权说明与免责声明",
};

const sections = [
  {
    id: "positioning",
    title: "项目定位",
    body: [
      "本项目仅用于技术研究、学习和个人数据管理，帮助用户整理和理解公开可访问的作品信息。",
      "EchoLens 不是抖音、字节跳动或任何权利人的官方产品，也不代表已获得平台、作者或第三方的授权、认可或背书。",
      "继续使用本项目前，用户应先确认自己的使用目的、处理对象和后续用途合法合规，并自行遵守适用法律法规及平台规则。",
    ],
  },
  {
    id: "legal-use",
    title: "合法使用前提",
    body: [
      "抖音作品可能包含视频、音频、图片、文字、字幕、配乐、肖像、商标等多类受保护内容，相关权利可能归属于原作者、平台、音乐权利人或其他第三方。",
      "用户仅可在自己拥有合法授权，或该使用属于法律法规允许的合理范围内使用本工具；如涉及公开发布、商业经营、账号运营、培训课程、素材分发或其他对外传播场景，应自行取得必要授权。",
      "本项目默认面向个人学习、研究、评论、信息整理等非侵权场景。用户应优先通过平台官方方式访问完整内容，并尊重原作者、平台和其他权利人的合法权益。",
    ],
  },
  {
    id: "prohibited",
    title: "禁止行为",
    body: [
      "禁止利用本项目侵犯他人的隐私权、著作权、信息网络传播权、复制权、改编权、肖像权、商标权或其他合法权利。",
      "禁止将本项目用于任何非法用途，或用于批量抓取、平台规避、账号滥用、内容搬运、生成侵权素材库、商业转售、未经授权的二次分发等行为。",
      "禁止将通过本项目获得的内容或结果包装为自己原创成果，或以任何方式误导第三方认为相关内容已经获得平台、作者或权利人的许可。",
    ],
  },
  {
    id: "risk",
    title: "风险与责任",
    body: [
      "用户须自行承担因使用本项目而产生的全部风险和责任，包括但不限于输入链接、功能选择、结果保存、内容传播和后续使用行为带来的法律后果。",
      "EchoLens 无法逐一核验每个作品的权属状态、授权链路或具体使用情境，也无法替用户判断某一使用方式是否已经取得充分授权。",
      "如果平台策略、接口、访问方式或内容结构发生变化，导致部分功能失效、结果异常或服务中断，这属于正常的技术风险。",
      "本页面内容仅用于说明项目的使用边界和合规原则，不构成正式法律意见；如涉及上线运营、商业化、版权投诉或平台合作，请咨询专业律师。",
    ],
  },
  {
    id: "notice",
    title: "权利人联系",
    body: [
      "如权利人认为相关内容、处理方式或使用结果侵犯其合法权益，可以联系网站运营方处理，邮箱：2201609540@qq.com。",
      "收到有效通知后，我们将根据实际情况核查并采取必要措施，包括限制、删除相关内容或停止相关功能。",
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
            请在使用 EchoLens 前阅读本声明。继续使用本项目，即表示你确认已理解本项目的定位、使用边界、风险责任与权利说明，并同意自行遵守相关法律法规和平台规则。
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
