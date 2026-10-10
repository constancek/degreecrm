import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("staff present a proposal in person: no phone check, signed copy notes who presented", async ({ page, context }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1180, height: 820 }); // iPad landscape
  await login(page);

  // A fresh lead with a sent proposal.
  await page.goto("/leads/new");
  await page.getByLabel("Name").fill("Present Person");
  await page.getByLabel("Phone").fill("513-555-0191");
  await page.getByLabel("Street address").fill("91 Present St");
  await page.getByLabel("What's the job?").fill("Furnace replacement");
  await page.getByRole("button", { name: "Create lead" }).click();
  await page.getByRole("link", { name: "New proposal" }).click();
  await page.getByLabel("Job notes").fill("Old furnace, cracked heat exchanger. Wants options.");
  await page.getByRole("button", { name: "Draft with Claude" }).click();
  await page.waitForURL(/\/proposals\//);
  await page.locator('[data-line="Specialty part not in price book"]').getByLabel("Unit price").fill("300");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  await page.getByRole("button", { name: "Send proposal" }).click();
  await expect(page.getByRole("link", { name: "Present to customer" })).toBeVisible();

  const [c] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "Present to customer" }).click()]);
  await c.waitForLoadState();
  await expect(c.getByText("Presenting in person: Owner")).toBeVisible();
  await expect(c.getByLabel(/last 4 digits/)).toHaveCount(0); // no phone check

  await c.locator('[data-option="good"]').getByRole("button", { name: "Choose this option" }).click();
  await c.getByLabel(/agree to the full/).check();
  await c.getByRole("button", { name: "Type", exact: true }).click();
  await c.getByLabel("Type your name as your signature").fill("Sarah Mitchell");
  await c.getByLabel(/I agree to sign electronically/).check();
  await c.getByRole("button", { name: "Approve & sign" }).click();
  await expect(c.getByText("Approved and signed")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Signed ✓")).toBeVisible();
  await page.getByRole("link", { name: /Present Person/ }).first().click();
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("presented the proposal in person");
});
