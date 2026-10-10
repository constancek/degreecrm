import type { Metadata } from "next";
import { cookies } from "next/headers";
import {
  clientState,
  gateCookieName,
  gateCookieValid,
  gateKind,
  loadByToken,
  recordView,
} from "@/lib/services/client-proposals";
import { getCompany } from "@/lib/services/company";
import { buildProposalView } from "@/lib/proposal-view";
import { formatPhone } from "@/lib/phone";
import { requestMeta } from "@/lib/server/request-meta";
import { FreshLinkButton, GateForm, ProposalChooser } from "./client-parts";

// Never the client's name in the title (SPEC.md Security).
export const metadata: Metadata = {
  title: { absolute: "Your proposal from Degree of Comfort" },
  openGraph: { title: "Your proposal from Degree of Comfort" },
  robots: { index: false, follow: false, nocache: true },
};

export default async function ProposalPage({ params }: PageProps<"/p/[token]">) {
  const { token } = await params;
  const [p, company] = await Promise.all([loadByToken(token), getCompany()]);
  const phone = formatPhone(company.phone);
  const callUs = phone ? (
    <a href={`tel:${company.phone}`} className="font-semibold text-brand">
      {phone}
    </a>
  ) : (
    "us"
  );

  if (!p) {
    return (
      <Message title="This link isn't valid">
        Please check the link in your text message, or call {callUs}.
      </Message>
    );
  }

  const state = clientState(p);
  if (state === "locked") {
    return (
      <Message title="This link is locked">
        For your security this proposal was locked after too many attempts. Call {callUs} and we&apos;ll send a new link.
      </Message>
    );
  }
  if (state === "signed") {
    return <Message title="Already approved">Thank you! This proposal has been approved. We&apos;ll be in touch about scheduling.</Message>;
  }
  if (state === "expired" || state === "superseded") {
    return (
      <Message title={state === "expired" ? "This proposal has expired" : "There's a newer version of this proposal"}>
        Prices and options may have changed. Tap below and we&apos;ll send you an updated proposal, or call {callUs}.
        <div className="mt-6">
          <FreshLinkButton token={token} />
        </div>
      </Message>
    );
  }

  const cookie = (await cookies()).get(gateCookieName(p.id))?.value;
  if (!gateCookieValid(p.id, token, cookie)) {
    return (
      <Shell>
        <div className="mx-auto max-w-sm py-10 text-center">
          <p className="text-lg font-semibold text-brand">{company.name}</p>
          <h1 className="mt-4 text-xl font-semibold">Your proposal is ready</h1>
          <GateForm token={token} kind={gateKind(p)} />
        </div>
      </Shell>
    );
  }

  await recordView(p, await requestMeta());
  const view = buildProposalView(p, company);
  return (
    <Shell>
      <ProposalChooser view={view} token={token} termsHref={view.termsVersion ? `/terms/${view.termsVersion}` : null} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-5xl flex-1 bg-white px-4 py-6 sm:px-8">{children}</main>;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="mt-2 text-sm text-gray-600">{children}</div>
      </div>
    </main>
  );
}
