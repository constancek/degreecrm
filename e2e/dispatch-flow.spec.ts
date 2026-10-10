import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SHOTS = process.env.CAL_SHOTS_DIR;
const todayEt = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

test("service call day: book with a window → tech running late, on the way, on site → declined with fee", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await login(page);

  // Owner: new lead, assigned to Mike, then book today's service call from the lead page.
  await page.goto("/leads/new");
  await page.getByLabel("Name").fill("Dee Clined");
  await page.getByLabel("Phone").fill("513-555-0164");
  await page.getByLabel("Street address").fill("9 Window Way");
  await page.getByLabel("ZIP").fill("45202");
  await page.getByLabel("What's the job?").fill("Furnace won't start");
  await page.getByLabel("Assign to").selectOption({ label: "Mike Reyes" });
  await page.getByRole("button", { name: "Create lead" }).click();
  await expect(page.getByRole("heading", { name: "Furnace won't start" })).toBeVisible();
  const leadUrl = page.url();

  await page.getByText("Book an estimate visit").click();
  await page.getByLabel("Date", { exact: true }).fill(todayEt());
  await page.getByLabel("Arrival window").selectOption("09-18");
  await page.getByLabel("Technician", { exact: true }).selectOption({ label: "Mike Reyes" });
  await page.getByRole("button", { name: "Book service call & text customer" }).click();
  await expect(page.getByText(/^Booked\./)).toBeVisible();
  await expect(page.getByRole("list", { name: "Visits" })).toContainText("arrive 9 am – 6 pm");

  // Tech on an iPad: My day.
  const techCtx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const t = await techCtx.newPage();
  await login(t, "tech1@example.com");
  await t.goto(`/my-day?day=${todayEt()}`);
  await expect(t.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(t.locator("[data-visit]").filter({ hasText: "Dee Clined" })).toContainText("9 am – 6 pm");
  if (SHOTS) {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const ph = await phone.newPage();
    await login(ph, "tech1@example.com");
    await ph.goto(`/my-day?day=${todayEt()}`);
    await ph.screenshot({ path: `${SHOTS}/today-phone.png`, fullPage: true });
    await phone.close();
  }
  // Tap the stop → appointment page: steps, buttons and the property brief.
  await t.getByRole("link", { name: "Dee Clined" }).first().click();
  await expect(t.getByRole("heading", { name: "Dee Clined" })).toBeVisible();
  await expect(t.getByRole("heading", { name: "Before you knock" })).toBeVisible();
  const card = t.locator("[data-visit]");
  // Nothing past the current step is offered yet.
  await expect(card.getByRole("link", { name: "Build estimate" })).toHaveCount(0);

  await card.getByRole("button", { name: "Running late" }).click();
  await card.getByRole("button", { name: "30 min" }).click();
  await expect(card).toContainText("Running late · customer told about");

  await card.getByRole("button", { name: "On my way" }).click();
  await expect(card.getByRole("button", { name: "Customer not home" })).toBeVisible();
  await card.getByRole("button", { name: "Arrived" }).click();
  // On site with no estimate: build one, or leave with just the trip fee. No "Declined" without an estimate.
  await expect(card.getByRole("link", { name: "Build estimate" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Declined – done" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Running late" })).toHaveCount(0);
  if (SHOTS) await t.screenshot({ path: `${SHOTS}/myday-onsite.png`, fullPage: true });

  await card.getByRole("button", { name: "Trip fee only – done" }).click();
  await expect(card.getByLabel("Collected on site")).toBeChecked();
  await card.getByLabel("Paid by").selectOption("cash");
  await card.getByRole("button", { name: "Save & leave" }).click();
  await expect(card).toContainText("Done · Estimate declined");
  await techCtx.close();

  // Owner: the card is in Declined with the fee badge; the timeline has the whole day.
  await page.goto("/pipeline");
  const declined = page.locator('section[data-stage="estimate_declined"]');
  await expect(declined).toContainText("Dee Clined");
  await expect(declined).toContainText("Fee collected $89");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pipeline.png` });
  await page.goto(leadUrl);
  const timeline = page.getByRole("list", { name: "Activity timeline" });
  await expect(timeline).toContainText("Running late");
  await expect(timeline).toContainText("moved it from On site to Declined");
  await expect(timeline).toContainText("Service call only, no estimate");
  await expect(timeline).toContainText("Service call fee $89.00 collected (cash)");
  await expect(page.getByRole("list", { name: "Text messages" })).toContainText("running behind at a previous call");
});
