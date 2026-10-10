"use client";

import { useActionState, useState, useTransition } from "react";
import { TRADES } from "@/lib/stages";
import type { Trade } from "@/generated/prisma/enums";
import { blankProposalAction, generateAction } from "../../../../proposals/actions";

const MAX_PHOTOS = 6;
const MAX_EDGE = 1600;

/** Phone photos are 3–8 MB; shrink to ~1600px JPEG in the browser so uploads stay small and fast. */
async function shrink(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

export function GenerateForm({ leadId, trade }: { leadId: string; trade: Trade }) {
  const [state, action, pending] = useActionState(generateAction.bind(null, leadId), undefined);
  const [photos, setPhotos] = useState<File[]>([]);
  const [blankPending, startBlank] = useTransition();
  const [blankError, setBlankError] = useState<string | null>(null);

  async function onPhotos(list: FileList | null) {
    const files = Array.from(list ?? []).slice(0, MAX_PHOTOS);
    setPhotos(await Promise.all(files.map(shrink)));
  }

  function submit(fd: FormData) {
    fd.delete("photos");
    photos.forEach((p) => fd.append("photos", p));
    action(fd);
  }

  return (
    <form action={submit} className="mt-4 space-y-4">
      {state?.error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
      <div className="card space-y-4 p-4">
        <div>
          <label className="label" htmlFor="trade">
            Trade
          </label>
          <select id="trade" name="trade" className="input" defaultValue={trade}>
            {TRADES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="notes">
            Job notes
          </label>
          <textarea
            id="notes"
            name="notes"
            className="input min-h-48"
            placeholder="What you found, what the customer wants, measurements… or paste a Plaud transcript."
            required
            minLength={10}
          />
        </div>
        <div>
          <label className="label" htmlFor="equipment">
            Equipment on site (optional)
          </label>
          <textarea id="equipment" name="equipment" className="input min-h-20" placeholder="e.g. Trane XR13 3-ton, 2009; 80% furnace" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="photos">
              Photos (up to {MAX_PHOTOS})
            </label>
            <input id="photos" type="file" accept="image/*" multiple onChange={(e) => onPhotos(e.target.files)} className="text-sm" />
            {photos.length > 0 && <p className="mt-1 text-xs text-gray-500">{photos.length} photo(s) ready</p>}
          </div>
          <div>
            <label className="label" htmlFor="targetMargin">
              Target margin % (optional)
            </label>
            <input id="targetMargin" name="targetMargin" type="number" min={0} max={90} className="input" placeholder="e.g. 45" />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" disabled={pending}>
          {pending ? "Claude is drafting… (up to a minute or two)" : "Draft with Claude"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || blankPending}
          onClick={() =>
            startBlank(async () => {
              const res = await blankProposalAction(leadId);
              if (res?.error) setBlankError(res.error);
            })
          }
        >
          Start blank instead
        </button>
        {blankError && <p className="text-sm text-red-700">{blankError}</p>}
      </div>
    </form>
  );
}
