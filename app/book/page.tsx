import type { Metadata } from "next";
import { bookableDates } from "@/lib/booking";
import { getCompany } from "@/lib/services/company";
import { formatPhone } from "@/lib/phone";
import { BookingForm } from "./booking-form";

export const metadata: Metadata = {
  title: { absolute: "Request an appointment · Degree of Comfort" },
  robots: { index: false, follow: false },
};

// Embeddable: https://go.cincydegreeofcomfort.com/book?embed=1 (see docs/website-booking.html).
export default async function BookPage({ searchParams }: PageProps<"/book">) {
  const { embed } = await searchParams;
  const company = await getCompany();
  const embedded = embed === "1";
  return (
    <main className={embedded ? "w-full bg-white p-4" : "mx-auto w-full max-w-2xl flex-1 bg-white px-4 py-8 sm:px-8"}>
      {!embedded && (
        <header className="mb-6">
          <p className="text-lg font-semibold text-brand">{company.name}</p>
          <h1 className="mt-2 text-2xl font-semibold">Request an appointment</h1>
          <p className="mt-1 text-sm text-gray-600">
            Pick a day and a 3-hour arrival window. We&apos;ll text you to confirm.
            {company.phone ? ` In a hurry? Call ${formatPhone(company.phone)}.` : ""}
          </p>
        </header>
      )}
      <BookingForm dates={bookableDates()} embedded={embedded} />
    </main>
  );
}
