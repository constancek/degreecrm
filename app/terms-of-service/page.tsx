import type { Metadata } from "next";
import Link from "next/link";
import { getCompany, companyAddressLine } from "@/lib/services/company";
import { currentTerms } from "@/lib/services/terms";
import { formatPhone } from "@/lib/phone";

export const metadata: Metadata = {
  title: { absolute: "Terms of Service · Degree of Comfort" },
  description: "Terms for using Degree of Comfort's booking form, proposal pages and staff CRM.",
};

const EFFECTIVE = "October 10, 2026";

// Public on both hosts (app. and go.). The contract terms for the work itself are the versioned T&C at /terms/[version].
export default async function TermsOfServicePage() {
  const [company, terms] = await Promise.all([getCompany(), currentTerms()]);
  const email = company.email || "hello@cincydegreeofcomfort.com";
  const phone = formatPhone(company.phone);
  const address = companyAddressLine(company);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 bg-white px-5 py-10 sm:px-10">
      <p className="text-sm font-semibold text-brand">{company.name}</p>
      <h1 className="mt-2 text-3xl font-semibold text-balance text-gray-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">Effective {EFFECTIVE}</p>

      <div className="mt-8 space-y-8 text-[15px] leading-7 text-gray-800 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-gray-900 [&_li]:mt-1 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-6">
        <section>
          <p>
            These terms cover your use of {company.name}&apos;s online tools: the booking form, the proposal and payment pages at{" "}
            <strong>go.cincydegreeofcomfort.com</strong>, and the staff customer management system (the &ldquo;CRM&rdquo;) at{" "}
            <strong>app.cincydegreeofcomfort.com</strong> (together, the &ldquo;Service&rdquo;). By using the Service you agree to these terms
            and to our{" "}
            <Link href="/privacy" className="text-brand underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>

        <section>
          <h2>The work itself is covered by our contract terms</h2>
          <p>
            These terms are about using the website. The heating, cooling, plumbing or electrical work you hire us for is covered by the proposal
            you approve and our{" "}
            {terms ? (
              <Link href={`/terms/${terms.version}`} className="text-brand underline">
                Terms &amp; Conditions
              </Link>
            ) : (
              "Terms & Conditions"
            )}{" "}
            (the version shown on your proposal). If the two ever conflict, the proposal and those Terms &amp; Conditions control the work.
          </p>
        </section>

        <section>
          <h2>Booking requests</h2>
          <p>
            A booking request asks for a day and arrival window. It isn&apos;t an appointment until we confirm it by text. Please give accurate
            contact details and a correct service address.
          </p>
        </section>

        <section>
          <h2>Proposals, electronic signatures and payments</h2>
          <ul>
            <li>
              Your proposal link is private to you. Don&apos;t share it. For your protection the page asks for the last four digits of your phone
              number, and the link locks after repeated wrong answers.
            </li>
            <li>Proposals are valid until the date shown on them. Prices and availability may change after that.</li>
            <li>
              When you approve a proposal online, you agree to do business electronically and that your drawn or typed signature is your legal
              signature, the same as signing on paper (under the federal E-SIGN Act and Ohio&apos;s Uniform Electronic Transactions Act). You can
              ask for a paper copy at any time. We send you a signed copy by email or text.
            </li>
            <li>
              Card payments are processed by Intuit QuickBooks Payments under its own terms. Financing, if offered, is provided by a third-party
              lender under its terms, and approval is up to the lender.
            </li>
          </ul>
        </section>

        <section>
          <h2>Text messages</h2>
          <p>
            By giving us your mobile number you agree to receive texts about your appointments, proposals, payments and service, plus occasional
            follow-ups and maintenance reminders. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, or HELP for
            help. Agreeing to texts is not a condition of buying anything.
          </p>
        </section>

        <section>
          <h2>Staff use of the CRM</h2>
          <p>
            The CRM is only for {company.name}&apos;s owner and technicians, signing in with an approved Google account. Staff must keep their
            accounts secure, use customer information only to do their jobs, and follow our Privacy Policy. We may remove access at any time.
            Connecting Google Calendar is optional and can be disconnected in Settings.
          </p>
        </section>

        <section>
          <h2>Acceptable use</h2>
          <p>
            Don&apos;t try to get into pages or data that aren&apos;t yours, interfere with the Service, send spam or false booking requests, or use
            automated tools to scrape it.
          </p>
        </section>

        <section>
          <h2>Availability and liability</h2>
          <p>
            We work to keep the Service available and accurate, but it is provided &ldquo;as is&rdquo; and may sometimes be unavailable. To the
            extent the law allows, {company.name} isn&apos;t liable for indirect or consequential losses from using the website. Nothing here
            limits the warranties or rights you have under your contract with us or under law.
          </p>
        </section>

        <section>
          <h2>Governing law and changes</h2>
          <p>
            These terms are governed by the laws of the State of Ohio. We may update them by posting a new version here with a new effective date.
            Changes don&apos;t affect proposals you&apos;ve already signed.
          </p>
        </section>

        <section>
          <h2>Contact us</h2>
          <p>
            {company.name}
            {address ? (
              <>
                <br />
                {address}
              </>
            ) : null}
            <br />
            Email: <a className="text-brand underline" href={`mailto:${email}`}>{email}</a>
            {phone ? (
              <>
                <br />
                Phone: {phone}
              </>
            ) : null}
          </p>
        </section>
      </div>

      <footer className="mt-12 flex gap-4 border-t pt-4 text-sm text-gray-500">
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>
      </footer>
    </main>
  );
}
