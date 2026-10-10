import type { Metadata } from "next";
import Link from "next/link";
import { getCompany, companyAddressLine } from "@/lib/services/company";
import { formatPhone } from "@/lib/phone";

export const metadata: Metadata = {
  title: { absolute: "Privacy Policy · Degree of Comfort" },
  description: "How Degree of Comfort collects, uses and protects information in its customer management system.",
};

const EFFECTIVE = "October 10, 2026";

// Public on both hosts (app. and go.). Linked from sign-in, the booking form and client pages.
export default async function PrivacyPage() {
  const company = await getCompany();
  const email = company.email || "hello@cincydegreeofcomfort.com";
  const phone = formatPhone(company.phone);
  const address = companyAddressLine(company);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 bg-white px-5 py-10 sm:px-10">
      <p className="text-sm font-semibold text-brand">{company.name}</p>
      <h1 className="mt-2 text-3xl font-semibold text-balance text-gray-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Effective {EFFECTIVE}</p>

      <div className="mt-8 space-y-8 text-[15px] leading-7 text-gray-800 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-gray-900 [&_h3]:mt-4 [&_h3]:font-semibold [&_h3]:text-gray-900 [&_li]:mt-1 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-6">
        <section>
          <p>
            {company.name} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is a heating, cooling, plumbing and electrical contractor in Cincinnati, Ohio. We run a
            customer management system (the &ldquo;CRM&rdquo;) at <strong>app.cincydegreeofcomfort.com</strong> and customer pages at{" "}
            <strong>go.cincydegreeofcomfort.com</strong> to schedule visits, send proposals, collect signatures and payments, and keep in touch with
            our customers. This policy explains what information the CRM handles, why, and the choices you have.
          </p>
        </section>

        <section>
          <h2>Who this policy covers</h2>
          <ul>
            <li>
              <strong>Customers and people who contact us</strong>, for example through our booking form, a proposal link, or a text message.
            </li>
            <li>
              <strong>Our staff</strong> (the owner and our technicians), who sign in to the CRM with their Google accounts.
            </li>
          </ul>
          <p className="mt-2">The CRM is a business tool for our own company. It isn&apos;t offered to the public as an app.</p>
        </section>

        <section>
          <h2>Information we collect</h2>
          <h3>From customers</h3>
          <ul>
            <li>Contact details: name, phone number, email address, and the service address.</li>
            <li>Details about the job: what you tell us, notes from our technicians, photos taken on site, and equipment information.</li>
            <li>Appointment requests and scheduled visits, proposals, the option you choose, and your agreement to our terms.</li>
            <li>
              Electronic signatures and the records that show a signature is genuine: the name you sign with, your drawn or typed signature, the
              date and time, your IP address, your device and browser type, and whether you confirmed the last four digits of your phone number.
            </li>
            <li>
              Payment records: amounts, dates and the last four digits of the card. Card numbers are entered directly into our payment processor
              (Intuit QuickBooks Payments) and never reach or are stored on our servers.
            </li>
            <li>Text messages you send to or receive from our business phone number, and their delivery status.</li>
            <li>Financing status updates from our financing partner when you choose to apply for financing.</li>
          </ul>
          <h3>From staff</h3>
          <ul>
            <li>Name, email address and profile picture from the Google account used to sign in.</li>
            <li>Activity in the CRM (for example, notes added or a visit marked complete), kept as an audit log.</li>
            <li>If a staff member connects Google Calendar: access to their calendar events, as described below.</li>
          </ul>
        </section>

        <section>
          <h2>How we use Google user data</h2>
          <p>
            Staff sign in with Google. We receive their name, email address and profile picture only to identify them and confirm they are
            allowed to use the CRM.
          </p>
          <p className="mt-3">
            A staff member can choose to connect their Google Calendar (permission:{" "}
            <code className="rounded bg-gray-100 px-1 text-sm">https://www.googleapis.com/auth/calendar.events</code>). We use this access only
            to:
          </p>
          <ul>
            <li>create, update and remove events on that person&apos;s calendar for the service visits assigned to them;</li>
            <li>notice when they move or delete one of those visit events in Google Calendar, so the schedule in the CRM stays the same.</li>
          </ul>
          <p className="mt-3">
            We only work with the events the CRM itself created. We do not read, copy or store any other events on the calendar. The
            connection is saved as an encrypted token and can be disconnected at any time in the CRM&apos;s Settings, or from the Google account&apos;s
            security settings.
          </p>
          <p className="mt-3 rounded-md border-l-4 border-brand bg-gray-50 p-4">
            {company.name}&apos;s use and transfer of information received from Google APIs adheres to the{" "}
            <a className="text-brand underline" href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Google user data is used only to provide the scheduling features described above. It is not
            sold, not used for advertising, not used to build profiles, and not used to train artificial intelligence models, and people at our
            company don&apos;t read it except to fix a problem the user asked us to fix or where the law requires.
          </p>
        </section>

        <section>
          <h2>How we use customer information</h2>
          <ul>
            <li>To schedule and carry out the work you request, and to send our technician to the right place.</li>
            <li>To prepare proposals, record your choice and signature, collect deposits and payments, and keep accurate business records.</li>
            <li>
              To send texts and emails about your appointment, proposal and payments, plus follow-ups and maintenance reminders. You can reply
              STOP to any text to stop receiving them.
            </li>
            <li>To answer questions, resolve disputes and meet our legal and tax obligations.</li>
          </ul>
          <p className="mt-2">We do not sell personal information, and we do not use it for advertising.</p>
        </section>

        <section>
          <h2>Service providers we use</h2>
          <p>We share information only with the companies that help us run the CRM, and only what each one needs:</p>
          <ul>
            <li>Vercel (hosting) and Neon (database), which store the CRM and its data in the United States.</li>
            <li>Google (staff sign-in, Calendar, and Maps for addresses, directions and drive times).</li>
            <li>Intuit QuickBooks (accounting and card payments).</li>
            <li>Quo (business phone and text messages) and Resend (email delivery).</li>
            <li>
              Anthropic (an artificial intelligence service that helps our staff draft proposals from their job notes and photos). Anthropic
              processes this information to provide that service to us.
            </li>
            <li>Discord (internal notifications to our team about new requests and schedule changes).</li>
            <li>Acorn Finance, only if you choose to apply for financing.</li>
          </ul>
          <p className="mt-2">We may also share information if the law requires it, or to protect our rights, our customers or our staff.</p>
        </section>

        <section>
          <h2>How we protect information</h2>
          <ul>
            <li>All connections use encryption (HTTPS).</li>
            <li>Staff access requires a Google sign-in on an approved list, and technicians see only the jobs assigned to them.</li>
            <li>
              Proposal links are private, hard-to-guess links that expire, and they ask for the last four digits of your phone number before
              showing anything. Customer pages are hidden from search engines.
            </li>
            <li>Sign-in tokens for Google and QuickBooks are encrypted when stored.</li>
            <li>Signed documents are stored privately with a fingerprint (hash) that shows if they were ever changed.</li>
          </ul>
        </section>

        <section>
          <h2>How long we keep information</h2>
          <p>
            We keep customer and job records, including signed proposals and payment records, for as long as we need them to serve you and to meet
            legal, warranty and tax requirements, generally at least seven years after the work. Staff calendar connections are kept until the
            staff member disconnects them or leaves the company. Text messages are kept as part of the customer&apos;s record.
          </p>
        </section>

        <section>
          <h2>Your choices and rights</h2>
          <ul>
            <li>Reply STOP to any text from us to stop texts; reply START to turn them back on.</li>
            <li>
              Ask us to see, correct or delete your information. We&apos;ll do so unless we must keep it, for example signed contracts and payment
              records we&apos;re required to retain.
            </li>
            <li>Staff can disconnect Google Calendar at any time in Settings, or revoke access in their Google account.</li>
          </ul>
        </section>

        <section>
          <h2>Children</h2>
          <p>Our services are for adults. We don&apos;t knowingly collect information from children under 13.</p>
        </section>

        <section>
          <h2>Changes to this policy</h2>
          <p>
            If we change this policy, we&apos;ll post the new version here and update the effective date. If a change affects how we use Google user
            data, we&apos;ll ask staff to agree again before using their data in the new way.
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

      <footer className="mt-12 border-t pt-4 text-sm text-gray-500">
        <Link href="/terms-of-service" className="underline">
          Terms of Service
        </Link>
      </footer>
    </main>
  );
}
