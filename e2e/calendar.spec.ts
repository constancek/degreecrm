import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const SHOTS = process.env.CAL_SHOTS_DIR;

function ymdIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  // Skip Sundays so the date is a normal workday.
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

test("calendar: book an estimate for a new customer from the week view, then see it in month and day views", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); // iPad landscape
  await login(page);
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();

  const day = ymdIn(8);
  await page.goto(`/calendar?view=week&date=${day}`);
  await page.getByRole("button", { name: "+ New appointment" }).click();
  const dialog = page.getByRole("dialog", { name: "New appointment" });
  await dialog.getByRole("radio", { name: "New customer" }).click();
  await dialog.getByLabel("Name").fill("Cal Endar");
  await dialog.getByLabel("Phone").fill("513-555-0163");
  await dialog.getByLabel("Street address").fill("12 Calendar Ln");
  await dialog.getByLabel("ZIP").fill("45202");
  await dialog.getByLabel("What's the job?").fill("Furnace making noise");
  await dialog.getByLabel("Date").fill(day);
  await dialog.getByLabel("Start time").fill("10:30");
  await dialog.getByLabel("Who's going").selectOption({ label: "Dana Cole" });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-appointment.png` });
  await dialog.getByRole("button", { name: "Book appointment" }).click();
  await expect(dialog).toBeHidden();

  const block = page.locator(`[data-day="${day}"]`).getByRole("link", { name: /Cal Endar/ });
  await expect(block).toBeVisible();
  await expect(block).toContainText("10:30 AM – 11:30 AM");
  await expect(block).toContainText("Estimate");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/week.png` });

  // Month view shows it as a chip on that day.
  await page.getByRole("tab", { name: "Month" }).click();
  await expect(page.locator(`[data-day="${day}"]`)).toContainText("Cal Endar");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/month.png`, fullPage: true });

  // Filter to job visits only: the estimate disappears.
  await page.getByLabel("Event type").selectOption("job");
  await expect(page.locator(`[data-day="${day}"]`)).not.toContainText("Cal Endar");
  await page.getByLabel("Event type").selectOption("all");

  // Clicking an empty slot in day view opens the form for that time; clicking the visit opens the lead.
  await page.goto(`/calendar?view=day&date=${day}`);
  const col = page.locator(`[data-day="${day}"]`).last();
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 8 + 52 * 8 + 5); // 2 pm (grid starts at 6 am, 52 px an hour)
  await expect(page.getByRole("dialog", { name: "New appointment" }).getByLabel("Start time")).toHaveValue("14:00");
  await page.keyboard.press("Escape");
  await page.goto(`/calendar?view=day&date=${day}`);
  await page.locator(`[data-day="${day}"]`).getByRole("link", { name: /Cal Endar/ }).click();
  await expect(page.getByRole("heading", { name: /Furnace making noise/ })).toBeVisible();
  await expect(page.getByText("Estimate Scheduled").first()).toBeVisible();

  // iPad portrait + phone render without horizontal scrolling.
  for (const [w, h, name] of [
    [820, 1180, "ipad-portrait"],
    [390, 844, "phone"],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/calendar?view=month&date=${day}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, name).toBeLessThanOrEqual(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
  }
});
