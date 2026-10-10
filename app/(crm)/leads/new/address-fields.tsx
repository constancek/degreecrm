"use client";

import { useEffect, useId, useRef, useState } from "react";

// Street address with Google Places (New) suggestions. Picking a suggestion fills unit/city/state/ZIP
// and the map coordinates. Without a key, or if Google rejects it, this is a plain address form.

const CINCINNATI = { lat: 39.1031, lng: -84.512 };

let placesPromise: Promise<google.maps.PlacesLibrary> | null = null;

function loadPlaces(apiKey: string): Promise<google.maps.PlacesLibrary> {
  if (!placesPromise) {
    placesPromise = new Promise<google.maps.PlacesLibrary>((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      w.__docMapsReady = () => google.maps.importLibrary("places").then((lib) => resolve(lib as google.maps.PlacesLibrary), reject);
      // Google calls this when the key is invalid or the referrer isn't allowed.
      w.gm_authFailure = () => reject(new Error("Google Maps rejected the API key (check key restrictions)"));
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&v=weekly&callback=__docMapsReady`;
      s.async = true;
      s.onerror = () => reject(new Error("Google Maps script failed to load"));
      document.head.appendChild(s);
    }).catch((err) => {
      placesPromise = null;
      throw err;
    });
  }
  return placesPromise!;
}

type Suggestion = { id: string; main: string; secondary: string; prediction: google.maps.places.PlacePrediction };

type Address = { street: string; unit: string; city: string; state: string; zip: string; lat: string; lng: string };

function parseComponents(components: google.maps.places.AddressComponent[]): Partial<Address> {
  const get = (type: string, short = false) => {
    const c = components.find((x) => x.types.includes(type));
    return (short ? c?.shortText : c?.longText) ?? "";
  };
  return {
    street: [get("street_number"), get("route")].filter(Boolean).join(" "),
    unit: get("subpremise"),
    city: get("locality") || get("sublocality") || get("postal_town") || get("administrative_area_level_3"),
    state: get("administrative_area_level_1", true),
    zip: get("postal_code"),
  };
}

export function AddressFields({ apiKey }: { apiKey?: string }) {
  const [addr, setAddr] = useState<Address>({ street: "", unit: "", city: "Cincinnati", state: "OH", zip: "", lat: "", lng: "" });
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const places = useRef<google.maps.PlacesLibrary | null>(null);
  const session = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = useRef(0);
  const listId = useId();

  useEffect(() => {
    if (!apiKey) return;
    loadPlaces(apiKey)
      .then((lib) => {
        places.current = lib;
      })
      .catch((err) => console.warn("[address autocomplete]", err.message));
  }, [apiKey]);

  const set = (patch: Partial<Address>) => setAddr((a) => ({ ...a, ...patch }));

  function onStreetChange(value: string) {
    // Typing over a picked address invalidates its coordinates.
    set({ street: value, lat: "", lng: "" });
    if (debounce.current) clearTimeout(debounce.current);
    const lib = places.current;
    if (!lib || value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      const q = ++query.current;
      session.current ??= new lib.AutocompleteSessionToken();
      try {
        const { suggestions: res } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: value,
          sessionToken: session.current,
          includedRegionCodes: ["us"],
          locationBias: { center: CINCINNATI, radius: 50_000 },
        });
        if (q !== query.current) return; // a newer keystroke won
        setSuggestions(
          res
            .map((s) => s.placePrediction)
            .filter((p): p is google.maps.places.PlacePrediction => Boolean(p))
            .slice(0, 5)
            .map((p) => ({
              id: p.placeId,
              main: p.mainText?.text ?? p.text.text,
              secondary: p.secondaryText?.text ?? "",
              prediction: p,
            })),
        );
        setActive(-1);
        setOpen(true);
      } catch (err) {
        console.warn("[address autocomplete]", (err as Error).message);
        setSuggestions([]);
      }
    }, 200);
  }

  async function pick(s: Suggestion) {
    setOpen(false);
    setSuggestions([]);
    set({ street: s.main });
    try {
      const place = s.prediction.toPlace();
      await place.fetchFields({ fields: ["addressComponents", "location"] });
      const parsed = parseComponents(place.addressComponents ?? []);
      set({
        ...Object.fromEntries(Object.entries(parsed).filter(([, v]) => v)),
        street: parsed.street || s.main,
        lat: place.location ? String(place.location.lat()) : "",
        lng: place.location ? String(place.location.lng()) : "",
      });
    } catch (err) {
      console.warn("[address autocomplete]", (err as Error).message);
    } finally {
      session.current = null; // a session ends with the details request
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      void pick(suggestions[active]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <>
      <div className="relative sm:col-span-4">
        <label className="label" htmlFor="street">
          Street address
        </label>
        <input
          id="street"
          name="street"
          className="input"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={addr.street}
          onChange={(e) => onStreetChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Start typing an address"
        />
        {open && suggestions.length > 0 && (
          <ul id={listId} role="listbox" className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-gray-200 bg-white text-sm shadow-lg">
            {suggestions.map((s, i) => (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer px-3 py-2 ${i === active ? "bg-brand/10" : "hover:bg-gray-50"}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void pick(s);
                }}
              >
                <span className="font-medium text-gray-900">{s.main}</span>{" "}
                <span className="text-gray-500">{s.secondary}</span>
              </li>
            ))}
            <li className="px-3 py-1 text-right text-[10px] text-gray-400">Powered by Google</li>
          </ul>
        )}
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="unit">
          Unit
        </label>
        <input id="unit" name="unit" className="input" value={addr.unit} onChange={(e) => set({ unit: e.target.value })} />
      </div>
      <div className="sm:col-span-4">
        <label className="label" htmlFor="city">
          City
        </label>
        <input id="city" name="city" className="input" value={addr.city} onChange={(e) => set({ city: e.target.value })} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="zip">
          ZIP
        </label>
        <input
          id="zip"
          name="zip"
          className="input"
          inputMode="numeric"
          value={addr.zip}
          onChange={(e) => set({ zip: e.target.value })}
        />
      </div>
      <input type="hidden" name="state" value={addr.state} />
      <input type="hidden" name="lat" value={addr.lat} />
      <input type="hidden" name="lng" value={addr.lng} />
    </>
  );
}
