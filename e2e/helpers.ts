import { expect, type Page } from "@playwright/test";

export async function login(page: Page, email = "owner@e2e.test") {
  await page.goto("/login");
  await page.getByLabel("Test login (E2E_AUTH)").fill(email);
  await page.getByRole("button", { name: "Sign in without Google" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
}
