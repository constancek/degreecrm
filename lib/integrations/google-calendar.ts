// Google Calendar (per tech, scope calendar.events) — events are written to the tech's primary calendar.
// The same Google OAuth client as staff sign-in is used for the separate "Connect Google Calendar" grant.

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export type CalendarEventInput = {
  eventId: string | null;
  summary: string;
  location: string;
  description: string;
  start: Date;
  end: Date;
  visitId: string;
};

export type CalendarEvent = {
  id: string;
  status: string; // confirmed | cancelled
  start: Date | null;
  end: Date | null;
  visitId: string | null;
  summary: string;
  allDay: boolean;
  transparent: boolean;
  /** All-day events: Eastern calendar dates "YYYY-MM-DD", end exclusive (as Google returns them). */
  startDate?: string;
  endDate?: string;
  /** Opens the event in Google Calendar. */
  htmlLink?: string;
};

export interface CalendarClient {
  /** Creates or updates the event; returns its id. A missing event (deleted in Google) is recreated. */
  upsertEvent(refreshToken: string, e: CalendarEventInput): Promise<string>;
  deleteEvent(refreshToken: string, eventId: string): Promise<void>;
  /** Events changed since `updatedMin` (includes cancelled ones). */
  listChanged(refreshToken: string, updatedMin: Date): Promise<CalendarEvent[]>;
  /** Events in a window (dispatch board busy blocks, the calendar page). */
  listBetween(refreshToken: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]>;
}

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const tokenCache = new Map<string, { token: string; expires: number }>();

async function accessToken(refreshToken: string): Promise<string> {
  const hit = tokenCache.get(refreshToken);
  if (hit && hit.expires > Date.now() + 60_000) return hit.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) throw new CalendarError(`Google token refresh failed: ${data.error ?? res.status}`, res.status === 400 ? 401 : res.status);
  tokenCache.set(refreshToken, { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

type GEvent = {
  id: string;
  status: string;
  summary?: string;
  transparency?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
};

function toEvent(e: GEvent): CalendarEvent {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  return {
    id: e.id,
    status: e.status,
    summary: e.summary ?? "",
    start: e.start?.dateTime ? new Date(e.start.dateTime) : e.start?.date ? new Date(`${e.start.date}T00:00:00`) : null,
    end: e.end?.dateTime ? new Date(e.end.dateTime) : e.end?.date ? new Date(`${e.end.date}T00:00:00`) : null,
    visitId: e.extendedProperties?.private?.crmVisitId ?? null,
    allDay,
    transparent: e.transparency === "transparent",
    startDate: e.start?.date,
    endDate: e.end?.date,
    htmlLink: e.htmlLink,
  };
}

export function createGoogleCalendarClient(): CalendarClient {
  const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  async function g<T>(refreshToken: string, url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${await accessToken(refreshToken)}`, "content-type": "application/json", ...init.headers },
    });
    if (!res.ok) throw new CalendarError(`Google Calendar ${init.method ?? "GET"}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
    return (res.status === 204 ? {} : await res.json()) as T;
  }
  function body(e: CalendarEventInput) {
    return JSON.stringify({
      summary: e.summary,
      location: e.location,
      description: e.description,
      start: { dateTime: e.start.toISOString(), timeZone: "America/New_York" },
      end: { dateTime: e.end.toISOString(), timeZone: "America/New_York" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
      extendedProperties: { private: { crmVisitId: e.visitId } },
    });
  }
  return {
    async upsertEvent(rt, e) {
      if (e.eventId) {
        try {
          const updated = await g<GEvent>(rt, `${base}/${encodeURIComponent(e.eventId)}`, { method: "PUT", body: body(e) });
          return updated.id;
        } catch (err) {
          if (!(err instanceof CalendarError) || (err.status !== 404 && err.status !== 410)) throw err;
        }
      }
      const created = await g<GEvent>(rt, base, { method: "POST", body: body(e) });
      return created.id;
    },
    async deleteEvent(rt, eventId) {
      try {
        await g(rt, `${base}/${encodeURIComponent(eventId)}`, { method: "DELETE" });
      } catch (err) {
        if (!(err instanceof CalendarError) || (err.status !== 404 && err.status !== 410)) throw err;
      }
    },
    async listChanged(rt, updatedMin) {
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({
          updatedMin: updatedMin.toISOString(),
          showDeleted: "true",
          singleEvents: "true",
          maxResults: "250",
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await g<{ items?: GEvent[]; nextPageToken?: string }>(rt, `${base}?${qs}`);
        // Only events the CRM created (they carry crmVisitId).
        out.push(...(page.items ?? []).map(toEvent).filter((e) => e.visitId));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
    async listBetween(rt, timeMin, timeMax) {
      const out: CalendarEvent[] = [];
      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
          ...(pageToken ? { pageToken } : {}),
        });
        const page = await g<{ items?: GEvent[]; nextPageToken?: string }>(rt, `${base}?${qs}`);
        out.push(...(page.items ?? []).map(toEvent).filter((e) => e.status !== "cancelled"));
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 2000);
      return out;
    },
  };
}

// ---- Mock -------------------------------------------------------------------------

type MockEvent = CalendarEventInput & { id: string; status: string; owner: string; updated: number };
const mockEvents: Map<string, MockEvent> = ((globalThis as Record<string, unknown>).__mockGcal ??= new Map()) as Map<string, MockEvent>;

export function createMockCalendarClient(): CalendarClient & { events: Map<string, MockEvent>; move(id: string, start: Date, end: Date): void } {
  return {
    events: mockEvents,
    async upsertEvent(rt, e) {
      const id = e.eventId && mockEvents.has(e.eventId) ? e.eventId : `evt_${mockEvents.size + 1}_${Date.now()}`;
      mockEvents.set(id, { ...e, eventId: id, id, status: "confirmed", owner: rt, updated: Date.now() });
      return id;
    },
    async deleteEvent(_rt, id) {
      const e = mockEvents.get(id);
      if (e) mockEvents.set(id, { ...e, status: "cancelled", updated: Date.now() });
    },
    async listChanged(rt, since) {
      return [...mockEvents.values()]
        .filter((e) => e.owner === rt && e.updated >= since.getTime())
        .map((e) => ({ id: e.id, status: e.status, start: e.start, end: e.end, visitId: e.visitId, summary: e.summary, allDay: false, transparent: false }));
    },
    async listBetween(rt, a, b) {
      return [...mockEvents.values()]
        .filter((e) => e.owner === rt && e.status !== "cancelled" && e.end > a && e.start < b)
        .map((e) => ({ id: e.id, status: e.status, start: e.start, end: e.end, visitId: e.visitId, summary: e.summary, allDay: false, transparent: false }));
    },
    move(id, start, end) {
      const e = mockEvents.get(id);
      if (e) mockEvents.set(id, { ...e, start, end, updated: Date.now() });
    },
  };
}

let override: CalendarClient | null = null;
export function setCalendarClient(c: CalendarClient | null) {
  override = c;
}
export function getCalendarClient(): CalendarClient {
  if (override) return override;
  if (process.env.MOCK_INTEGRATIONS === "1" && process.env.VERCEL_ENV !== "production") return createMockCalendarClient();
  return createGoogleCalendarClient();
}
