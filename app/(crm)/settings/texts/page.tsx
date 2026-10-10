import type { Metadata } from "next";
import Link from "next/link";
import { requireOwner } from "@/lib/session";
import { SEQUENCE_PLACEHOLDERS, TRIGGERS, listSequences } from "@/lib/services/sequences";
import { SequenceEditor } from "./sequence-editor";

export const metadata: Metadata = { title: "Automatic texts" };

export default async function TextsPage() {
  await requireOwner();
  const sequences = await listSequences();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4">
      <Link href="/settings" className="text-sm text-brand hover:underline">
        ← Settings
      </Link>
      <h1 className="text-lg font-semibold">Automatic texts</h1>
      <p className="text-sm text-gray-600">
        Sent 9 am–8 pm Eastern, Monday to Saturday. A customer&apos;s reply, STOP, or the lead moving on stops the sequence. The
        first automatic text to a customer always ends with &ldquo;Reply STOP to opt out.&rdquo; Placeholders: {SEQUENCE_PLACEHOLDERS}
      </p>
      {sequences.map((s) => (
        <SequenceEditor
          key={s.id}
          id={s.id}
          triggerLabel={TRIGGERS.find((t) => t.id === s.trigger)?.label ?? s.trigger}
          initial={{
            name: s.name,
            active: s.active,
            steps: s.steps.map((st) => ({ anchor: st.anchor, offsetHours: st.offsetHours, template: st.template, personalize: st.personalize })),
          }}
        />
      ))}
    </div>
  );
}
