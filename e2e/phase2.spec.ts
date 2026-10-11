import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { connectMcp, login } from "./helpers";

test("owner sets up company + price book, drafts with Claude, prices, sends; customer opens, chooses, downloads the PDF", async ({
  page,
  browser,
}) => {
  await login(page);

  // Company details
  await page.goto("/settings");
  await page.getByLabel("Phone number").fill("513-555-0100");
  await page.getByLabel("Support email").fill("hello@cincydegreeofcomfort.com");
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Price book
  await page.goto("/pricebook");
  await page.getByRole("button", { name: "Add item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Smart thermostat");
  await page.getByLabel("Trade", { exact: true }).selectOption("hvac");
  await page.getByLabel("Category", { exact: true }).selectOption("equipment");
  await page.getByLabel("Customer price $").fill("350");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("cell", { name: "Smart thermostat" })).toBeVisible();

  // Draft with Claude (mocked in E2E) on Sarah's AC lead
  await page.goto("/pipeline");
  await page.getByRole("link", { name: "Sarah Mitchell" }).click();
  await page.getByRole("link", { name: "New proposal" }).click();
  await page.getByLabel("Job notes").fill("Upstairs AC not cooling; 14 year old 3 ton unit. Wants options.");
  await page.getByRole("button", { name: "Draft with Claude" }).click();
  await page.waitForURL(/\/proposals\//);
  await expect(page.getByText("drafted by Claude")).toBeVisible();
  // Packages are lump sums typed by staff; the optional add-on Claude couldn't match needs a price too.
  await expect(page.getByText("Essential: enter the package price.")).toBeVisible();
  await expect(page.getByText("Supreme: 1 optional add-on(s) still need a price.")).toBeVisible();
  await page.getByLabel("Essential package price").fill("6800");
  await page.getByLabel("Premium package price").fill("8900");
  await page.getByLabel("Supreme package price").fill("12500");
  await expect(page.getByTestId("total-good")).toHaveText("$7,330.40"); // 6,800 + 7.8% tax
  const flagged = page.locator('[data-line="Specialty part not in price book"]');
  await expect(flagged.getByText("Needs price")).toBeVisible();
  await flagged.getByLabel("Add-on unit price").fill("425");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(page.getByText("Ready to send")).toBeVisible();

  // Send (Quo is log-only in E2E)
  await page.getByRole("button", { name: "Send proposal" }).click();
  const linkBox = page.getByLabel("Proposal link");
  await expect(linkBox).toBeVisible();
  await expect(page.getByText("Texted to the customer at (513) 555-0111.")).toBeVisible();
  const link = await linkBox.inputValue();
  expect(link).toMatch(/^http:\/\/go\.localhost:3100\/p\/[A-Za-z0-9_-]{32}$/);

  // Customer on a phone, on the go. host
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const c = await phone.newPage();
  await c.goto(link);
  await expect(c).toHaveTitle("Your proposal from Degree of Comfort");
  await expect(c.getByText("Sarah")).toHaveCount(0); // nothing personal before the gate
  await c.getByLabel(/last 4 digits/).fill("9999");
  await c.getByRole("button", { name: "View proposal" }).click();
  await expect(c.getByText("4 attempts left")).toBeVisible();
  await c.getByLabel(/last 4 digits/).fill("0111");
  await c.getByRole("button", { name: "View proposal" }).click();

  await expect(c.getByText(/^#\d{4}$/)).toBeVisible(); // estimate number
  await expect(c.getByText("Valid until")).toBeVisible();
  await expect(c.locator("[data-option]")).toHaveCount(3);
  await expect(c.locator('[data-option="good"]')).toContainText("Essential");
  await expect(c.locator('[data-option="best"]')).toContainText("Supreme");
  await expect(c.locator('[data-option="better"]')).toContainText("Recommended");
  await c.locator('[data-option="better"]').getByRole("button", { name: "Choose this package" }).click();
  await expect(c.locator("#approve")).toContainText("You chose");
  await expect(c.locator("#approve")).toContainText("Deposit due on approval");
  const terms = c.getByRole("link", { name: "Terms & Conditions" });
  await expect(terms).toHaveAttribute("href", /\/terms\/\d+/);
  await c.getByLabel(/agree to the full/).check();

  const [download] = await Promise.all([c.waitForEvent("download"), c.getByRole("link", { name: "Download PDF" }).click()]);
  const pdf = readFileSync((await download.path())!);
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(pdf.length).toBeGreaterThan(20_000);

  // Owner sees the activity
  await page.reload();
  await expect(page.getByText(/Viewed 1×/)).toBeVisible();
  await expect(page.getByText("Customer is looking at")).toBeVisible();
  await phone.close();
});

test("a tech drafts a proposal from Claude over MCP; only the owner can send", async ({ page, request }) => {
  const mcp = await connectMcp(page, request, "tech1@example.com");
  const tools = await mcp.rpc("tools/list");
  const names = tools.result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("create_proposal_draft");
  expect(names).not.toContain("send_proposal");

  const [lead] = await mcp.tool("search_leads", { query: "Porter" });
  const book = await mcp.tool("get_price_book", { trade: "plumbing" });
  const heater = book.find((i: { name: string }) => i.name.startsWith("50 gal gas water heater (standard)"));
  const labor = book.find((i: { name: string }) => i.name === "Plumbing labor");

  const opt = (tier: string, qty: number) => ({
    tier,
    title: `${tier} heater swap`,
    highlights: ["Hauled away", "Permit handled", "Same day", "Warranty"],
    lineItems: [
      { description: "Water heater", qty: 1, priceBookItemId: heater.id },
      { description: "Labor", qty, unit: "hr", priceBookItemId: labor.id },
    ],
  });
  const draft = await mcp.tool("create_proposal_draft", {
    leadId: lead.id,
    summary: "Your heater needs replacing.",
    options: [opt("good", 3), opt("better", 4), opt("best", 5)],
  });
  expect(draft.status).toBe("draft");
  expect(draft.options[0]).toMatchObject({ package: "Essential", packagePrice: "not set" });
  expect(draft.sendBlockers).toContain("Essential: enter the package price.");

  for (const [tier, dollars] of [["good", 1670], ["better", 1900], ["best", 2400]] as const) {
    await mcp.tool("update_proposal_option", { proposalId: draft.proposalId, tier, packagePriceDollars: dollars });
  }
  const updated = await mcp.tool("update_proposal_option", { proposalId: draft.proposalId, tier: "best", title: "Supreme swap" });
  expect(updated.options[2].title).toBe("Supreme swap");
  expect(updated.options[0].total).toBe("$1,800.26"); // 1,670 × 1.078 Hamilton County tax
  expect(updated.sendBlockers).toEqual([]);

  await page.goto(`/proposals/${draft.proposalId}`);
  // Techs can't text the link, but can present the estimate on site.
  await expect(page.getByRole("heading", { name: "Go over it with the customer" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Present to customer" })).toBeVisible();
  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByRole("list", { name: "Activity timeline" })).toContainText("drafted a proposal");
});
