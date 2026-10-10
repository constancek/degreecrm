import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ENV } from "../playwright.config";
import { login } from "./helpers";

// Uses the seeded demo: the water-heater proposal for James & Linda Porter (phone ends 0112),
// assigned to Mike Reyes (tech1). All outside services are mocked (MOCK_INTEGRATIONS=1).

async function demoLink(page: Page) {
  await login(page);
  await page.getByRole("link", { name: "James & Linda Porter" }).click();
  await page.getByRole("link", { name: "v1" }).click();
  return page.getByLabel("Proposal link").inputValue();
}

const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

test.describe.configure({ mode: "serial" });

test("customer signs and pays the deposit; owner schedules; tech completes; invoice goes out", async ({ page, browser }) => {
  test.setTimeout(120_000); // long flow, and the signed PDF is rendered by headless Chrome
  const link = await demoLink(page);

  // ---- Customer: choose, agree, sign on the page, pay by card (mock Intuit) ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const c = await phone.newPage();
  await c.goto(link);
  await c.getByLabel(/last 4 digits/).fill("0112");
  await c.getByRole("button", { name: "View proposal" }).click();
  await c.locator('[data-option="better"]').getByRole("button", { name: "Choose this option" }).click();
  await c.getByLabel(/agree to the full/).check();
  await expect(c.getByLabel("Your full name")).toHaveValue("James & Linda Porter");
  await c.getByLabel("Email for your signed copy").fill("porters@example.com");
  // Draw a signature on the pad.
  const pad = c.getByLabel("Signature pad: draw your signature");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await c.mouse.move(box.x + 30, box.y + 100);
  await c.mouse.down();
  for (let i = 1; i <= 20; i++) await c.mouse.move(box.x + 30 + i * 10, box.y + 100 - Math.sin(i / 2) * 30);
  await c.mouse.up();
  await expect(c.getByRole("button", { name: "Approve & sign" })).toBeDisabled(); // consent still needed
  await c.getByLabel(/I agree to sign electronically/).check();
  await c.getByRole("button", { name: "Approve & sign" }).click();
  await expect(c.getByText("Approved and signed")).toBeVisible();
  await expect(c.getByRole("link", { name: "Download signed copy" })).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([c.waitForEvent("download"), c.getByRole("link", { name: "Download signed copy" }).click()]);
  const { readFileSync } = await import("node:fs");
  expect(readFileSync((await dl.path())!).subarray(0, 4).toString()).toBe("%PDF");

  await c.getByLabel("Card number").fill("4111 1111 1111 1111");
  await c.getByLabel("Expires (MM/YY)").fill("12/30");
  await c.getByLabel("CVC").fill("123");
  await c.getByLabel("Billing ZIP").fill("45213");
  await c.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(c.getByText("Deposit received. Thank you!")).toBeVisible();
  await phone.close();

  // ---- Owner: proposal shows signed + deposit, job exists, schedule a visit tomorrow ----
  await page.reload();
  await expect(page.getByText("Signed ✓")).toBeVisible();
  await expect(page.getByText(/received/)).toBeVisible();
  await page.getByRole("link", { name: "Open the job →" }).click();
  await expect(page.getByRole("heading", { name: /Water heater leaking/ })).toBeVisible();
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  await page.getByLabel("Date", { exact: true }).fill(tomorrow);
  await page.getByLabel("Arrival window").selectOption("exact");
  await page.getByLabel("Arrival time").fill("10:00");
  await page.getByLabel("Time on site").selectOption("3");
  await page.getByLabel("Technician", { exact: true }).selectOption({ label: "Mike Reyes" });
  await page.getByRole("button", { name: "Schedule job visit & text customer" }).click();
  await expect(page.getByText(/^Booked\./)).toBeVisible();
  await expect(page.getByRole("list", { name: "Visits" })).toContainText("Mike Reyes");
  const jobUrl = page.url();

  // ---- Tech: my day → On my way → Start work → Complete ----
  const techCtx = await browser.newContext();
  const t = await techCtx.newPage();
  await login(t, "tech1@example.com");
  await t.goto(`/my-day?day=${tomorrow}`);
  // The next stop is open on Today with its one next button.
  const card = t.locator("[data-visit]").first();
  await expect(card).toContainText("James & Linda Porter");
  await card.getByRole("button", { name: "On my way" }).click();
  await card.getByRole("button", { name: "Start work" }).click();
  await card.getByRole("button", { name: "Complete" }).click();
  await expect(t.locator("[data-visit]").filter({ hasText: "James & Linda Porter" })).toContainText("Done");
  await techCtx.close();

  // ---- Owner: job invoiced via (mock) QuickBooks ----
  await page.goto(jobUrl);
  await expect(page.getByText("invoiced", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "QuickBooks invoice" })).toBeVisible();
});

test("dispatch board: slot finder books an estimate for a new lead", async ({ page }) => {
  await login(page);
  await page.goto("/dispatch");
  await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible();
  const firstLead = page.locator('[data-unscheduled^="lead:"]').first();
  await expect(firstLead).toBeVisible();
  const customer = (await firstLead.locator("p").first().textContent())!;
  const before = await page.locator('[data-unscheduled^="lead:"]').count();
  await page.getByLabel("Job or estimate").selectOption({ label: `${customer}: estimate` });
  await page.getByRole("button", { name: "Find next openings" }).click();
  const slots = page.getByRole("list", { name: "Open slots" });
  await expect(slots.getByRole("button", { name: "Book" }).first()).toBeVisible();
  await slots.getByRole("button", { name: "Book" }).first().click();
  await expect(page.locator('[data-unscheduled^="lead:"]')).toHaveCount(before - 1);
  await page.goto("/pipeline");
  await expect(page.locator('section[data-stage="estimate_scheduled"]')).toContainText(customer);
});

test("texts: one-off text, signed inbound webhook, sequences editor", async ({ page, request }) => {
  await login(page);
  await page.getByRole("link", { name: "Sarah Mitchell" }).click();
  await page.getByLabel("Text message", { exact: true }).fill("Hi Sarah, see you soon!");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("list", { name: "Text messages" })).toContainText("Hi Sarah, see you soon!");

  // Quo webhook for an inbound reply (signed like Quo does).
  const body = JSON.stringify({
    object: { type: "message.received", data: { object: { id: "msg_e2e_1", from: "+15135550111", text: "Thanks, Tuesday works", direction: "incoming" } } },
  });
  const ts = String(Date.now());
  const sig = createHmac("sha256", Buffer.from(E2E_ENV.QUO_WEBHOOK_SECRET, "base64")).update(`${ts}.${body}`).digest("base64");
  const bad = await request.post("/api/webhooks/quo", { headers: { "openphone-signature": `hmac;1;${ts};nope`, "content-type": "application/json" }, data: body });
  expect(bad.status()).toBe(401);
  const ok = await request.post("/api/webhooks/quo", { headers: { "openphone-signature": `hmac;1;${ts};${sig}`, "content-type": "application/json" }, data: body });
  expect(ok.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("list", { name: "Text messages" })).toContainText("Thanks, Tuesday works");

  await page.goto("/settings/texts");
  await expect(page.getByRole("textbox", { name: "Sequence name" })).toHaveCount(6);
  const first = page.locator("section").filter({ has: page.getByRole("textbox", { name: "Sequence name" }) }).first();
  await first.getByRole("button", { name: "Save" }).click();
  await expect(first.getByText("Saved")).toBeVisible();

});
