import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { appUrl } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { SOURCE_IDS, STAGE_IDS, TRADE_IDS, stageInfo } from "@/lib/stages";
import { formatAddress } from "@/lib/notifications/discord-embeds";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/lib/services/actor";
import { createLead, getLead, logNote, searchLeads, type LeadSummary } from "@/lib/services/leads";
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

  return server;
}
