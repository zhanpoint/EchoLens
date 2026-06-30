import Link from "next/link";

type LegalSection = {
  body: string[];
  id?: string;
  title: string;
};

export function LegalDocument({
  description,
  sections,
  title,
}: {
  description: string;
  sections: LegalSection[];
  title: string;
}) {
  return (
    <main className="app-shell min-h-[100dvh] overflow-x-hidden bg-background text-foreground">
      <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 sm:gap-5 sm:px-5 sm:py-8 md:py-12">
        <header className="rounded-lg border border-white/15 bg-black/20 p-4 sm:p-6">
          <Link className="text-sm font-semibold text-cyan transition hover:text-amber" href="/">
            返回首页
          </Link>
          <h1 className="mt-5 text-2xl font-semibold leading-tight text-foreground sm:text-3xl">{title}</h1>
          <p className="mobile-readable mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        </header>

        <div className="grid gap-4">
          {sections.map((section) => (
            <section
              key={section.id ?? section.title}
              id={section.id}
              className="scroll-mt-6 rounded-lg border border-white/15 bg-black/20 p-4 sm:p-6"
            >
              <h2 className="text-lg font-semibold leading-tight text-foreground">{section.title}</h2>
              <div className="mobile-readable mt-4 grid gap-3 text-sm leading-6 text-muted-foreground">
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
