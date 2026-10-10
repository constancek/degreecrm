import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appUrl } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { SOURCE_IDS, STAGE_IDS, TRADE_IDS, stageInfo } from "@/lib/stages";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/lib/services/actor";
import { createLead, getLead, logNote, searchLeads, type LeadSummary } from "@/lib/services/leads";
import { listPriceBook } from "@/lib/services/pricebook";
import {
  createProposalDraft,
  getProposal,
  saveProposal,
  sendProblems,
  sendProposal,
  toEditInput,
  type FullProposal,
} from "@/lib/services/proposals";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { listVisits, updateVisitStatus } from "@/lib/services/visits";
import { addDaysYmd, easternMidnight, easternYmd } from "@/lib/services/dispatch";
import type { StaffActor } from "@/lib/session";

// The MCP tools call the same service layer as the web UI, so permissions and side effects
// (activity log, Discord) are identical. Every call is also written to Activity for audit.

function summarize(l: LeadSummary) {
  return {
    id: l.id,
    title: l.title,
    customer: l.customer.name,
    phone: formatPhone(l.customer.phone) || null,
    address: formatAddress(l.property) || null,
    trade: l.trade,
    stage: l.stage,
    stageLabel: stageInfo(l.stage).label,
    assignedTo: l.assignedTo?.name ?? null,
    url: `${appUrl()}/leads/${l.id}`,
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(err: unknown) {
  const known =
    err instanceof NotFoundError || err instanceof ForbiddenError || err instanceof ValidationError || err instanceof z.ZodError;
  if (!known) console.error("[mcp]", err);
  const message =
    err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : known ? (err as Error).message : "Internal error";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

async function audit(actor: Actor, tool: string, args: unknown, leadId?: string) {
  await db.activity
    .create({
      data: {
        type: "mcp_call",
        userId: actor.kind === "user" ? actor.id : null,
        data: { tool, args: JSON.parse(JSON.stringify(args ?? {})), ...(leadId ? { leadId } : {}) },
      },
    })
    .catch((e) => console.error("[mcp audit]", e));
}

/** Wraps a tool handler with audit logging and friendly errors. */
function run<A>(actor: Actor, tool: string, fn: (args: A) => Promise<{ result: unknown; leadId?: string }>) {
  return async (args: A) => {
    try {
      const { result, leadId } = await fn(args);
      await audit(actor, tool, args, leadId);
      return json(result);
    } catch (err) {
      await audit(actor, tool, args);
      return toolError(err);
    }
  };
}

export function buildMcpServer(actor: StaffActor) {
  const server = new McpServer(
    { name: "degree-of-comfort-crm", version: "0.1.0" },
    {
      instructions:
        `You are connected to the Degree of Comfort CRM as ${actor.name} (${actor.role}). ` +
        "Leads move through a pipeline of stages. Use search_leads to find a lead id, get_lead for details and history, " +
        "create_lead for new service calls, and log_note to record what happened. " +
        "For proposals: read the lead and get_price_book, draft Good/Better/Best in the chat and confirm with the user, then create_proposal_draft. " +
        "Prices come only from the price book; lines without a price book id are flagged for the owner to price. " +
        "Drafts are reviewed and sent by the owner (send_proposal is owner-only). " +
        (actor.role === "tech" ? "As a tech you only see leads assigned to you." : ""),
    },
  );

  server.registerTool(
    "search_leads",
    {
      title: "Search leads",
      description:
        "Find leads by customer name, phone, email, street or job title. Empty query returns the most recently active leads.",
      inputSchema: {
        query: z.string().default("").describe("Name, phone digits, email, street or words from the job title"),
        stage: z.enum(STAGE_IDS).optional().describe("Only leads in this pipeline stage"),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    run(actor, "search_leads", async ({ query, stage, limit }: { query: string; stage?: (typeof STAGE_IDS)[number]; limit: number }) => ({
      result: (await searchLeads(actor, query, { stage, limit })).map(summarize),
    })),
  );

  server.registerTool(
    "get_lead",
    {
      title: "Get lead",
      description: "Full details for one lead: customer, property, stage, notes and the most recent activity.",
      inputSchema: { leadId: z.string().describe("Lead id from search_leads") },
      annotations: { readOnlyHint: true },
    },
    run(actor, "get_lead", async ({ leadId }: { leadId: string }) => {
      const lead = await getLead(actor, leadId);
      return {
        leadId: lead.id,
        result: {
          ...summarize(lead),
          source: lead.source,
          notes: lead.notes,
          customer: {
            id: lead.customer.id,
            name: lead.customer.name,
            type: lead.customer.type,
            phone: formatPhone(lead.customer.phone) || null,
            email: lead.customer.email,
          },
          property: lead.property && {
            id: lead.property.id,
            address: formatAddress(lead.property),
            notes: lead.property.notes,
          },
          createdAt: lead.createdAt.toISOString(),
          stageChangedAt: lead.stageChangedAt.toISOString(),
          activity: lead.activities.slice(0, 30).map((a) => ({
            at: a.createdAt.toISOString(),
            type: a.type,
            by: a.user?.name ?? "System",
            body: a.body,
            data: a.data,
          })),
        },
      };
    }),
  );

  server.registerTool(
    "create_lead",
    {
      title: "Create lead",
      description:
        "Create a new lead (service call). The customer is matched by phone, then email, or created. " +
        "Confirm the details with the user before calling.",
      inputSchema: {
        customerName: z.string().min(1),
        phone: z.string().optional().describe("US phone number"),
        email: z.string().optional(),
        customerType: z.enum(["residential", "commercial"]).default("residential"),
        street: z.string().optional().describe("Street address of the job site"),
        unit: z.string().optional(),
        city: z.string().optional().describe("Defaults to Cincinnati"),
        zip: z.string().optional(),
        title: z.string().min(1).describe("Short job description, e.g. 'Water heater leaking'"),
        trade: z.enum(TRADE_IDS),
        source: z.enum(SOURCE_IDS).default("mcp"),
        notes: z.string().optional(),
      },
    },
    run(actor, "create_lead", async (a: {
      customerName: string;
      phone?: string;
      email?: string;
      customerType: "residential" | "commercial";
      street?: string;
      unit?: string;
      city?: string;
      zip?: string;
      title: string;
      trade: (typeof TRADE_IDS)[number];
      source: (typeof SOURCE_IDS)[number];
      notes?: string;
    }) => {
      const lead = await createLead(actor, {
        customer: { name: a.customerName, phone: a.phone, email: a.email, type: a.customerType },
        property: a.street ? { street: a.street, unit: a.unit, city: a.city, zip: a.zip } : undefined,
        title: a.title,
        trade: a.trade,
        source: a.source,
        notes: a.notes,
      });
      return { leadId: lead.id, result: summarize(lead) };
    }),
  );

  server.registerTool(
    "log_note",
    {
      title: "Log note",
      description: "Add a note to a lead's activity timeline.",
      inputSchema: {
        leadId: z.string(),
        body: z.string().min(1).describe("The note text"),
      },
    },
    run(actor, "log_note", async ({ leadId, body }: { leadId: string; body: string }) => {
      const note = await logNote(actor, leadId, body);
      return { leadId, result: { ok: true, noteId: note.id, at: note.createdAt.toISOString() } };
    }),
  );

  // ---- Proposals -------------------------------------------------------------

  const tierEnum = z.enum(["good", "better", "best"]);
  const lineSchema = z.object({
    description: z.string().min(1),
    qty: z.number().positive(),
    unit: z.string().default("ea"),
    priceBookItemId: z.string().nullable().describe("Price book item id, or null if nothing fits (owner prices it)"),
    isOptional: z.boolean().default(false).describe("Optional add-on, not included in the total"),
  });
  const optionSchema = z.object({
    tier: tierEnum,
    title: z.string().min(1),
    summary: z.string().default(""),
    highlights: z.array(z.string()).describe("4-6 short customer-facing benefits"),
    warrantyText: z.string().default(""),
    lineItems: z.array(lineSchema),
  });

  server.registerTool(
    "get_price_book",
    {
      title: "Get price book",
      description: "Price book items (id, name, unit, price) for a trade, including items shared by every trade. Use ids in proposal line items.",
      inputSchema: { trade: z.enum(TRADE_IDS), query: z.string().optional().describe("Filter by words in the name/description") },
      annotations: { readOnlyHint: true },
    },
    run(actor, "get_price_book", async ({ trade, query }: { trade: (typeof TRADE_IDS)[number]; query?: string }) => ({
      result: (await listPriceBook({ trade, query })).map((i) => ({
        id: i.id,
        category: i.category,
        name: i.name,
        description: i.description,
        unit: i.unit,
        price: formatCents(i.priceCents, { cents: true }),
      })),
    })),
  );

  server.registerTool(
    "create_proposal_draft",
    {
      title: "Create proposal draft",
      description:
        "Save a Good/Better/Best proposal draft on a lead. Exactly three options (good, better, best). Prices are filled from the " +
        "price book; lines with priceBookItemId null are flagged 'needs price'. The draft is not sent to the customer.",
      inputSchema: {
        leadId: z.string(),
        summary: z.string().describe("One paragraph for the customer"),
        recommendedTier: tierEnum.nullable().default("better"),
        assumptions: z.array(z.string()).default([]),
        exclusions: z.array(z.string()).default([]),
        options: z.array(optionSchema).length(3),
      },
    },
    run(actor, "create_proposal_draft", async (a: { leadId: string } & Record<string, unknown>) => {
      const { leadId, ...content } = a;
      const p = await createProposalDraft(actor, leadId, content as never, { aiModel: "claude (MCP)" });
      return { leadId, result: proposalSummary(p) };
    }),
  );

  server.registerTool(
    "update_proposal_option",
    {
      title: "Update proposal option",
      description:
        "Change one option (good/better/best) of a draft proposal. Fields you omit stay as they are. lineItems replaces the whole list. " +
        "Price book lines take the price book price" + (actor.role === "owner" ? "; custom lines may set unitPriceDollars." : "; custom lines are left for the owner to price."),
      inputSchema: {
        proposalId: z.string(),
        tier: tierEnum,
        title: z.string().optional(),
        summary: z.string().optional(),
        highlights: z.array(z.string()).optional(),
        warrantyText: z.string().optional(),
        lineItems: z.array(lineSchema.extend({ unitPriceDollars: z.number().min(0).optional() })).optional(),
      },
    },
    run(actor, "update_proposal_option", async (a: {
      proposalId: string;
      tier: "good" | "better" | "best";
      title?: string;
      summary?: string;
      highlights?: string[];
      warrantyText?: string;
      lineItems?: (z.infer<typeof lineSchema> & { unitPriceDollars?: number })[];
    }) => {
      const p = await getProposal(actor, a.proposalId);
      const edit = toEditInput(p);
      const option = edit.options.find((o) => o.tier === a.tier)!;
      if (a.title !== undefined) option.title = a.title;
      if (a.summary !== undefined) option.summary = a.summary;
      if (a.highlights !== undefined) option.highlights = a.highlights;
      if (a.warrantyText !== undefined) option.warrantyText = a.warrantyText;
      if (a.lineItems) {
        const ids = a.lineItems.map((l) => l.priceBookItemId).filter((x): x is string => Boolean(x));
        const book = new Map((await db.priceBookItem.findMany({ where: { id: { in: ids } } })).map((i) => [i.id, i]));
        option.lineItems = a.lineItems.map((l) => {
          const item = l.priceBookItemId ? book.get(l.priceBookItemId) : undefined;
          const custom = actor.role === "owner" && l.unitPriceDollars != null ? Math.round(l.unitPriceDollars * 100) : 0;
          return {
            description: l.description,
            qty: l.qty,
            unit: item?.unit ?? l.unit,
            unitCents: item ? item.priceCents : custom,
            isOptional: l.isOptional,
            priceBookItemId: item?.id ?? null,
          };
        });
      }
      const saved = await saveProposal(actor, a.proposalId, edit);
      return { leadId: saved.leadId, result: proposalSummary(saved) };
    }),
  );

  if (actor.role === "owner") {
    server.registerTool(
      "send_proposal",
      {
        title: "Send proposal",
        description:
          "Owner only. Send a draft proposal to the customer: creates the private link (valid 30 days), moves the lead to Estimate sent " +
          "and optionally texts the link from the company number. Confirm with the user before calling.",
        inputSchema: { proposalId: z.string(), textCustomer: z.boolean().default(true) },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      run(actor, "send_proposal", async ({ proposalId, textCustomer }: { proposalId: string; textCustomer: boolean }) => {
        const res = await sendProposal(actor, proposalId, { textCustomer });
        const p = await getProposal(actor, proposalId);
        return { leadId: p.leadId, result: res };
      }),
    );
  }

  // ---- Visits ---------------------------------------------------------------

  const VTIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });

  server.registerTool(
    "list_my_visits",
    {
      title: "List my visits",
      description: "Your scheduled visits (estimates and job days) for a day, default today (Eastern time).",
      inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to today"), days: z.number().int().min(1).max(7).default(1) },
      annotations: { readOnlyHint: true },
    },
    run(actor, "list_my_visits", async ({ date, days }: { date?: string; days: number }) => {
      const ymd = date ?? easternYmd(new Date());
      const visits = await listVisits(actor, { from: easternMidnight(ymd), to: easternMidnight(addDaysYmd(ymd, days)), techId: actor.id });
      return {
        result: visits.map((v) => ({
          visitId: v.id,
          when: `${VTIME.format(v.start)}–${VTIME.format(v.end)}`,
          kind: v.kind,
          status: v.status,
          customer: v.lead.customer.name,
          phone: formatPhone(v.lead.customer.phone) || null,
          address: formatAddress(v.lead.property) || null,
          accessNotes: v.lead.property?.notes ?? null,
          job: v.job?.title ?? v.lead.title,
          notes: v.notes,
          leadId: v.leadId,
        })),
      };
    }),
  );

  server.registerTool(
    "update_visit_status",
    {
      title: "Update visit status",
      description:
        "Mark a visit en_route (optionally texting the customer you're on the way), in_progress, or done. Completing the last job visit completes the job and sends the final invoice.",
      inputSchema: {
        visitId: z.string(),
        status: z.enum(["en_route", "in_progress", "done"]),
        notifyCustomer: z.boolean().default(true).describe("For en_route: text the customer"),
      },
    },
    run(actor, "update_visit_status", async ({ visitId, status, notifyCustomer }: { visitId: string; status: "en_route" | "in_progress" | "done"; notifyCustomer: boolean }) => {
      const v = await updateVisitStatus(actor, visitId, status, { notifyCustomer });
      return { leadId: v.leadId, result: { visitId: v.id, status: v.status } };
    }),
  );

  // ---- Resources -------------------------------------------------------------

  server.registerResource(
    "lead",
    new ResourceTemplate("crm://lead/{id}", { list: undefined }),
    { title: "Lead", description: "A lead with customer, property and recent activity", mimeType: "application/json" },
    async (uri, vars) => {
      const lead = await getLead(actor, String(vars.id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...summarize(lead), notes: lead.notes, activity: lead.activities.slice(0, 20).map((x) => ({ at: x.createdAt, type: x.type, body: x.body })) }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "pricebook",
    new ResourceTemplate("crm://pricebook/{trade}", { list: undefined }),
    { title: "Price book", description: "Active price book items for a trade (hvac, plumbing, electrical)", mimeType: "application/json" },
    async (uri, vars) => {
      const trade = String(vars.trade);
      if (!(TRADE_IDS as string[]).includes(trade)) throw new Error("Unknown trade");
      const items = await listPriceBook({ trade: trade as (typeof TRADE_IDS)[number] });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(items.map((i) => ({ id: i.id, category: i.category, name: i.name, description: i.description, unit: i.unit, priceCents: i.priceCents }))),
          },
        ],
      };
    },
  );

  return server;
}

function proposalSummary(p: FullProposal) {
  return {
    proposalId: p.id,
    version: p.version,
    status: p.status,
    url: `${appUrl()}/proposals/${p.id}`,
    tax: p.taxLabel || "no rate found for this address",
    options: p.options.map((o) => ({
      tier: o.tier,
      title: o.title,
      total: formatCents(o.totalCents, { cents: true }),
      linesNeedingPrice: o.lineItems.filter((l) => l.needsPrice).map((l) => l.description),
    })),
    sendBlockers: sendProblems(p),
  };
}
