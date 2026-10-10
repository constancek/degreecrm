import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test.describe.configure({ mode: "serial" });

test("website booking request → owner confirms the window → visit booked, stage moves", async ({ page, browser }) => {
  // Customer on the embeddable page (go. host).
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const c = await ctx.newPage();
  const res = await c.goto("http://go.localhost:3100/book?embed=1");
  expect(res!.headers()["content-security-policy"]).toContain("frame-ancestors 'self' https://cincydegreeofcomfort.com");
  await c.getByLabel("Name").fill("Booker Test");
  await c.getByLabel("Mobile phone").fill("513-555-0187");
  await c.getByLabel("Service address").fill("77 Booking Ave");
  await c.getByLabel("ZIP").fill("45202");
  await c.getByLabel("Plumbing").check();
  await c.getByLabel("What's going on?").fill("Kitchen sink is backing up");
  const first = c.getByRole("group", { name: "First choice" });
  const second = c.getByRole("group", { name: "Second choice" });
  const day = await first.getByLabel("Day", { exact: true }).locator("option").nth(2).getAttribute("value");
  await first.getByLabel("Day", { exact: true }).selectOption(day!);
  await first.getByLabel("12 pm – 3 pm").check();
  // Submitting without a second choice is refused by the browser (required).
  await second.getByLabel("Day", { exact: true }).selectOption({ index: 3 });
  await second.getByLabel("All day (9 am – 6 pm)").check();
  await c.getByRole("button", { name: "Request appointment" }).click();
  await expect(c.getByText("Request received")).toBeVisible();
  await ctx.close();

  // Owner sees it on the pipeline and confirms on the lead page.
  await login(page);
  const card = page.locator("[data-lead-id]").filter({ hasText: "Booker Test" });
  await expect(card).toContainText("Requested");
  await card.getByRole("link", { name: "Booker Test" }).click();
  const panel = page.getByRole("region", { name: "Booking request" });
  await expect(panel).toContainText("12 pm – 3 pm");
  await expect(panel).toContainText("All day (9 am – 6 pm)");
  await panel.getByLabel("Tech").selectOption({ label: "Dana Cole" });
  await panel.getByRole("button", { name: "Confirm & text customer" }).click();
  await expect(page.getByRole("list", { name: "Visits" })).toContainText("Dana Cole");
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("moved it from New request to Scheduled");
  await expect(page.getByRole("list", { name: "Text messages" })).toContainText("We got your request");
});

test("pipeline drag into Scheduled opens the booking dialog and books it", async ({ page, request }) => {
  await request.post("/api/intake/web", {
    headers: { origin: "https://cincydegreeofcomfort.com" },
    data: { name: "Drag Booker", phone: "513-555-0178", street: "78 Main St", message: "Breaker trips" },
  });
  await login(page);
  const card = page.locator("[data-lead-id]").filter({ hasText: "Drag Booker" });
  const target = page.locator('section[data-stage="estimate_scheduled"]');
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y + 20, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 15 });
  await page.mouse.up();

  const dialog = page.getByRole("dialog", { name: "Move to Scheduled" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Arrival window").selectOption("09-12");
  await dialog.getByLabel("Tech").selectOption({ label: "Mike Reyes" });
  await dialog.getByRole("button", { name: "Book & text customer" }).click();
  await expect(dialog).toBeHidden();
  await expect(target).toContainText("Drag Booker");

  // Dragging back to New is a plain move (no dialog).
  const back = page.locator('section[data-stage="new"]');
  const c2 = (await target.locator("[data-lead-id]").filter({ hasText: "Drag Booker" }).boundingBox())!;
  const b2 = (await back.boundingBox())!;
  await page.mouse.move(c2.x + 20, c2.y + 10);
  await page.mouse.down();
  await page.mouse.move(c2.x + 30, c2.y + 20, { steps: 3 });
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 80, { steps: 15 });
  await page.mouse.up();
  await expect(back).toContainText("Drag Booker");
});
