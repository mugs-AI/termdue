import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const QNE_BASE = "https://openapi.account.qne.cloud";

const InputSchema = z.object({
  token: z.string().min(20, { message: "Missing QNE session token" }),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  salesperson: z.string().optional().default(""),
  termCode: z.string().optional().default(""),
});

const ExchangeSchema = z.object({
  apiKey: z.string().uuid({ message: "QNE API key must be a valid GUID" }),
});

const RefreshSchema = z.object({
  token: z.string().min(20),
});

const ToggleCustomerStatusSchema = z.object({
  token: z.string().min(20),
  customerId: z.number().int().positive(),
});

export class QneUnauthorizedError extends Error {
  constructor(message = "QNE session expired") {
    super(message);
    this.name = "QneUnauthorizedError";
  }
}

export type OverdueInvoice = {
  id: string;
  customerId: number | null;
  docCode: string;
  refNo: string;
  docDate: string;
  dueDate: string | null;
  customerCode: string;
  customerName: string;
  salespersonCode: string;
  termCode: string;
  netTotalAmount: number;
  outstandingAmount: number;
  currencyCode: string;
  daysOverdue: number;
};

export type OverdueResult = {
  fetchedAt: string;
  fromDate: string;
  toDate: string;
  totalCount: number;
  totalOutstanding: number;
  currency: string;
  invoices: OverdueInvoice[];
  companyName?: string;
  salespeople: string[];
  termCodes: string[];
  customerStatuses: Record<string, number>;
};

async function getJwt(apiKey: string): Promise<string> {
  const res = await fetch(`${QNE_BASE}/api/auth/connect?api-key=${encodeURIComponent(apiKey)}`, {
    method: "GET",
  });
  if (!res.ok) {
    throw new Error(`QNE auth failed (${res.status}). Check your API key.`);
  }
  const body = (await res.json()) as { code?: string; message?: string; data?: { token?: string } };
  if (body.code !== "0000" || !body.data?.token) {
    throw new Error(body.message || "QNE rejected the API key.");
  }
  return body.data.token;
}

async function getCompanyName(jwt: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${QNE_BASE}/api/companyprofile`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { companyName?: string; name?: string } };
    return body.data?.companyName || body.data?.name;
  } catch {
    return undefined;
  }
}

export const exchangeApiKey = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ExchangeSchema.parse(input))
  .handler(async ({ data }): Promise<{ token: string; companyName?: string }> => {
    const token = await getJwt(data.apiKey);
    const companyName = await getCompanyName(token);
    return { token, companyName };
  });

export const refreshSession = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RefreshSchema.parse(input))
  .handler(async ({ data }): Promise<{ token: string }> => {
    const res = await fetch(`${QNE_BASE}/api/Auth/Refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${data.token}` },
    });
    if (!res.ok) {
      throw new QneUnauthorizedError(`QNE refresh failed (${res.status}).`);
    }
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      data?: { token?: string };
    };
    if (body.code !== "0000" || !body.data?.token) {
      throw new QneUnauthorizedError(body.message || "QNE refresh rejected.");
    }
    return { token: body.data.token };
  });

export const toggleCustomerSuspension = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ToggleCustomerStatusSchema.parse(input))
  .handler(async ({ data }): Promise<{ status: 0 | 3 }> => {
    const headers = { Authorization: `Bearer ${data.token}` };
    const customerRes = await fetch(`${QNE_BASE}/api/Customers/${data.customerId}`, { headers });
    if (customerRes.status === 401) throw new QneUnauthorizedError();
    if (!customerRes.ok)
      throw new Error(`Unable to load the QNE customer (${customerRes.status}).`);

    const customerBody = (await customerRes.json()) as {
      code?: string;
      message?: string;
      data?: Record<string, unknown> & { status?: number };
    };
    if (customerBody.code !== "0000" || !customerBody.data) {
      throw new Error(customerBody.message || "QNE could not find this customer.");
    }

    const status: 0 | 3 = customerBody.data.status === 3 ? 0 : 3;
    const updateRes = await fetch(`${QNE_BASE}/api/Customers/Update`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...customerBody.data, status }),
    });
    if (updateRes.status === 401) throw new QneUnauthorizedError();
    if (!updateRes.ok) throw new Error(`Unable to update the QNE customer (${updateRes.status}).`);

    const updateBody = (await updateRes.json()) as { code?: string; message?: string };
    if (updateBody.code !== "0000") {
      throw new Error(updateBody.message || "QNE rejected the customer status update.");
    }
    return { status };
  });

export const fetchOverdueInvoices = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<OverdueResult> => {
    const jwt = data.token;
    const today = new Date().toISOString().slice(0, 10);

    const filterParts = [
      `isCancelled eq false`,
      `outstandingAmount gt 0`,
      `dueDate lt ${today}`,
      `docDate ge ${data.fromDate}`,
      `docDate le ${data.toDate}`,
    ];
    if (data.salesperson) {
      filterParts.push(`salespersonCode eq '${data.salesperson.replace(/'/g, "''")}'`);
    }
    if (data.termCode) {
      filterParts.push(`creditTermCode eq '${data.termCode.replace(/'/g, "''")}'`);
    }

    const url = new URL(`${QNE_BASE}/api/SalesInvoices/List`);
    url.searchParams.set("$filter", filterParts.join(" and "));
    url.searchParams.set("$orderby", "dueDate asc");
    url.searchParams.set("$top", "1000");

    const [invRes, companyName] = await Promise.all([
      fetch(url.toString(), { headers: { Authorization: `Bearer ${jwt}` } }),
      getCompanyName(jwt),
    ]);

    if (invRes.status === 401) {
      throw new QneUnauthorizedError();
    }
    if (!invRes.ok) {
      const text = await invRes.text();
      throw new Error(`QNE invoice fetch failed (${invRes.status}): ${text.slice(0, 200)}`);
    }
    const body = (await invRes.json()) as {
      code?: string;
      message?: string;
      data?: { count?: number; value?: Array<Record<string, unknown>> };
    };
    if (body.code !== "0000" || !body.data) {
      throw new Error(body.message || "QNE returned an unexpected response.");
    }

    const rows = body.data.value ?? [];
    const now = Date.now();
    const invoices: OverdueInvoice[] = rows.map((r) => {
      const dueDate = (r.dueDate as string | null) ?? null;
      const daysOverdue = dueDate
        ? Math.max(0, Math.floor((now - new Date(dueDate).getTime()) / 86_400_000))
        : 0;
      return {
        id: String(r.id ?? ""),
        customerId: Number.isInteger(Number(r.customerId)) ? Number(r.customerId) : null,
        docCode: String(r.docCode ?? ""),
        refNo: String(r.refNo ?? r.referenceNo ?? r.reference ?? ""),
        docDate: String(r.docDate ?? "").slice(0, 10),
        dueDate: dueDate ? String(dueDate).slice(0, 10) : null,
        customerCode: String(r.customerCode ?? ""),
        customerName: String(r.customerName ?? ""),
        salespersonCode: String(r.salespersonCode ?? r.salesPersonCode ?? ""),
        termCode: String(r.creditTermCode ?? r.termCode ?? ""),
        netTotalAmount: Number(r.netTotalAmount ?? 0),
        outstandingAmount: Number(r.outstandingAmount ?? 0),
        currencyCode: String(r.currencyCode ?? ""),
        daysOverdue,
      };
    });

    const totalOutstanding = invoices.reduce((sum, i) => sum + i.outstandingAmount, 0);
    const currency = invoices[0]?.currencyCode ?? "";
    const salespeople = Array.from(
      new Set(invoices.map((i) => i.salespersonCode).filter(Boolean)),
    ).sort();
    const termCodes = Array.from(new Set(invoices.map((i) => i.termCode).filter(Boolean))).sort();
    const customerIds = Array.from(
      new Set(
        invoices.map((invoice) => invoice.customerId).filter((id): id is number => id !== null),
      ),
    );
    const customerStatuses: Record<string, number> = {};

    if (customerIds.length > 0) {
      const customersUrl = new URL(`${QNE_BASE}/api/Customers/List`);
      customersUrl.searchParams.set("$filter", `id in (${customerIds.join(",")})`);
      customersUrl.searchParams.set("$top", String(customerIds.length));
      const customersRes = await fetch(customersUrl, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (customersRes.status === 401) throw new QneUnauthorizedError();
      if (customersRes.ok) {
        const customersBody = (await customersRes.json()) as {
          code?: string;
          data?: { value?: Array<{ id?: number; status?: number }> };
        };
        if (customersBody.code === "0000") {
          for (const customer of customersBody.data?.value ?? []) {
            if (customer.id !== undefined && customer.status !== undefined) {
              customerStatuses[String(customer.id)] = customer.status;
            }
          }
        }
      }
    }

    return {
      fetchedAt: new Date().toISOString(),
      fromDate: data.fromDate,
      toDate: data.toDate,
      totalCount: body.data.count ?? invoices.length,
      totalOutstanding,
      currency,
      invoices,
      companyName,
      salespeople,
      termCodes,
      customerStatuses,
    };
  });

const InsightSchema = z.object({
  summary: z.object({
    totalCount: z.number(),
    totalOutstanding: z.number(),
    currency: z.string(),
    topCustomers: z.array(
      z.object({ customerName: z.string(), outstanding: z.number(), count: z.number() }),
    ),
    bucketsByAge: z.record(z.string(), z.number()),
    oldestDays: z.number(),
  }),
});

export const getAiInsights = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InsightSchema.parse(input))
  .handler(async ({ data }): Promise<{ tips: string[] }> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI gateway not configured.");

    const prompt = `You are a credit-control analyst. Return EXACTLY 5 ultra-short, actionable tips based on this overdue-AR snapshot. Each tip MUST be a single sentence of at most 15 words. No numbering, no bullets, no preamble — one tip per line.\n\nDATA:\n${JSON.stringify(data.summary)}`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You produce concise, expert AR collection insights. Always reply with exactly 5 lines, each a short sentence of 15 words or fewer.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI gateway error (${res.status}): ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const tips = text
      .split(/\n+/)
      .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((s) => s.length > 0)
      .slice(0, 5);
    return { tips };
  });
