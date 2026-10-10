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
  const card = t.locator("[data-visit]").filter({ hasText: "Dee Clined" });
  await expect(card).toContainText("Arrive 9 am – 6 pm");

  await card.getByRole("button", { name: "Running late" }).click();
  await card.getByRole("button", { name: "30 min" }).click();
  await expect(card).toContainText("Running late · customer told about");

  await card.getByRole("button", { name: "On my way" }).click();
  await card.getByRole("button", { name: "Arrived" }).click();
  await expect(card.getByRole("button", { name: "Declined – done" })).toBeVisible();
  if (SHOTS) await t.screenshot({ path: `${SHOTS}/myday-onsite.png` });

  await card.getByRole("button", { name: "Declined – done" }).click();
  await card.getByLabel("Why declined").selectOption("Too expensive");
  await card.getByLabel("Collected on site").check();
  await card.getByLabel("Paid by").selectOption("cash");
  if (SHOTS) await t.screenshot({ path: `${SHOTS}/myday-declined.png` });
  await card.getByRole("button", { name: "Save & leave" }).click();
  await expect(card).toContainText("Done ✓ · Estimate declined");
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
  await expect(timeline).toContainText("Service call fee $89.00 collected (cash)");
  await expect(page.getByRole("list", { name: "Text messages" })).toContainText("running behind at a previous call");
});
