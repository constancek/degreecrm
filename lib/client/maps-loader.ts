// Loads the Google Maps JavaScript API once per page (browser key, restricted to our domains).

let loading: Promise<typeof google.maps> | null = null;

export function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (typeof window !== "undefined" && typeof (window as { google?: { maps?: unknown } }).google?.maps === "object") return Promise.resolve(window.google.maps);
  if (!loading) {
    loading = new Promise<typeof google.maps>((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      w.__docMapsLoaded = () => resolve(window.google.maps);
      w.gm_authFailure = () => reject(new Error("Google Maps rejected the API key"));
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&loading=async&v=weekly&callback=__docMapsLoaded`;
      s.async = true;
      s.onerror = () => reject(new Error("Google Maps failed to load"));
      document.head.appendChild(s);
    }).catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
