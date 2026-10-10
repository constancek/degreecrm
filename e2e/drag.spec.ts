import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

// Real pointer drags (dnd-kit needs a few intermediate moves past its 6px activation distance).
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  const box = (await from.boundingBox())!;
  const sx = box.x + Math.min(20, box.width / 2);
  const sy = box.y + Math.min(10, box.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.move(to.x + 1, to.y + 1);
  await page.mouse.up();
}

const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

test.describe.configure({ mode: "serial" });

test("pipeline: dragging a card to Needs scheduling runs the stage automation (drip starts)", async ({ page, request }) => {
  // A fresh lead with a phone number, so texts can be enrolled.
  await request.post("/api/intake/web", {
    headers: { origin: "https://cincydegreeofcomfort.com" },
    data: { name: "Drag Pipeline", phone: "513-555-0161", street: "10 Main St", message: "Thermostat dead" },
  });
  await login(page);
  const card = page.locator("[data-lead-id]").filter({ hasText: "Drag Pipeline" });
  const target = page.locator('section[data-stage="follow_up"]');
  const box = (await target.boundingBox())!;
  await drag(page, card, { x: box.x + box.width / 2, y: box.y + 80 });
  await expect(target).toContainText("Drag Pipeline");
  await page.waitForTimeout(600); // clicks right after a drop are ignored (they'd be the drop itself)

  await target.getByRole("link", { name: "Drag Pipeline" }).click();
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("moved it from New request to Needs scheduling");
  await expect(page.getByRole("list", { name: "Automatic texts" })).toContainText("Book an estimate");
});

test("dispatch: dragging an estimate request onto a tech books it; dragging the visit reschedules it", async ({ page, request }) => {
  await request.post("/api/intake/web", {
    headers: { origin: "https://cincydegreeofcomfort.com" },
    data: { name: "Drag Dispatch", phone: "513-555-0162", street: "20 Main St", message: "No cooling upstairs" },
  });
  await login(page);
  const day = ymd(new Date(Date.now() + 2 * 86_400_000));
  await page.goto(`/dispatch?date=${day}`);

  const columns = page.locator("[data-tech-column]");
  const headers = await page.locator(".grid > div.border-b.border-l").allTextContents();
  const mikeIdx = headers.findIndex((h) => h.startsWith("Mike Reyes"));
  const danaIdx = headers.findIndex((h) => h.startsWith("Dana Cole"));
  const ROW = 12; // px per 15 minutes, grid starts 7 am

  // Drop on Mike at 10:00.
  const mike = (await columns.nth(mikeIdx).boundingBox())!;
  const item = page.locator('[data-unscheduled^="lead:"]').filter({ hasText: "Drag Dispatch" });
  await drag(page, item, { x: mike.x + mike.width / 2, y: mike.y + (10 - 7) * 4 * ROW + ROW / 2 });
  const block = columns.nth(mikeIdx).locator("[data-visit]").filter({ hasText: "Drag Dispatch" });
  await expect(block).toContainText("10:00 AM");
  await expect(item).toHaveCount(0);

  // Move it to Dana at 1:00 pm.
  const dana = (await columns.nth(danaIdx).boundingBox())!;
  await drag(page, block, { x: dana.x + dana.width / 2, y: dana.y + (13 - 7) * 4 * ROW + ROW / 2 });
  const moved = columns.nth(danaIdx).locator("[data-visit]").filter({ hasText: "Drag Dispatch" });
  await expect(moved).toContainText("1:00 PM");

  // Automations ran like any other booking.
  await page.goto("/pipeline");
  const scheduled = page.locator('section[data-stage="estimate_scheduled"]');
  await expect(scheduled).toContainText("Drag Dispatch");
  await scheduled.getByRole("link", { name: "Drag Dispatch" }).click();
  await expect(page.getByRole("list", { name: "Visits" })).toContainText("Dana Cole");
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("rescheduled a visit");
  // Confirmation + 24 h reminder are queued; the every-minute scheduler sends them (9 am–8 pm, Mon–Sat).
  await expect(page.getByRole("list", { name: "Automatic texts" })).toContainText(/Service call booked\s*step 1 of 2/);
});
