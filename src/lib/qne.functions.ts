import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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

function htmlToLines(html: string): string[] {
  if (!html) return [];
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

async function fetchCompanyHeaderLines(jwt: string): Promise<string[]> {
  try {
    const res = await fetch(`${QNE_BASE}/api/companyprofile`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data || {};
    const candidates = [
      "header",
      "headerHtml",
      "headerHTML",
      "reportHeader",
      "letterHead",
      "letterhead",
    ];
    let html = "";
    for (const key of candidates) {
      const v = d[key];
      if (typeof v === "string" && v.trim()) {
        html = v;
        break;
      }
    }
    if (!html) {
      for (const v of Object.values(d)) {
        if (typeof v === "string" && /<\w+[^>]*>/.test(v)) {
          html = v;
          break;
        }
      }
    }
    const lines = htmlToLines(html);
    if (lines.length) return lines;
    const name = (d.companyName as string) || (d.name as string) || "";
    return name ? [name] : [];
  } catch {
    return [];
  }
}

type InvoiceItem = {
  stockCode: string;
  description: string;
  qty: number;
  uom: string;
  unitPrice: number;
  amount: number;
};

async function fetchInvoiceItems(jwt: string, id: string): Promise<InvoiceItem[]> {
  if (!id) return [];
  try {
    const res = await fetch(`${QNE_BASE}/api/SalesInvoices/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data;
    if (!d) return [];
    const keys = ["details", "invoiceDetails", "salesInvoiceDetails", "lines", "items"];
    let arr: Array<Record<string, unknown>> | null = null;
    for (const k of keys) {
      const v = d[k];
      if (Array.isArray(v) && v.length) {
        arr = v as Array<Record<string, unknown>>;
        break;
      }
    }
    if (!arr) {
      for (const v of Object.values(d)) {
        if (
          Array.isArray(v) &&
          v.length &&
          typeof v[0] === "object" &&
          v[0] &&
          ("description" in (v[0] as object) || "stockCode" in (v[0] as object))
        ) {
          arr = v as Array<Record<string, unknown>>;
          break;
        }
      }
    }
    if (!arr) return [];
    return arr.map((r) => ({
      stockCode: String(r.stockCode ?? r.itemCode ?? r.code ?? ""),
      description: String(r.description ?? r.itemDescription ?? r.desc ?? r.remark ?? ""),
      qty: Number(r.qty ?? r.quantity ?? 0),
      uom: String(r.uom ?? r.unit ?? ""),
      unitPrice: Number(r.unitPrice ?? r.price ?? 0),
      amount: Number(r.netAmount ?? r.amount ?? r.subTotal ?? r.lineTotal ?? 0),
    }));
  } catch {
    return [];
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

const WhatsappSchema = z.object({
  token: z.string().min(20),
  customerId: z.number().int().positive(),
  customerName: z.string(),
  customerCode: z.string(),
  companyName: z.string().optional().default(""),
  currency: z.string().optional().default(""),
  invoices: z.array(
    z.object({
      id: z.string().optional().default(""),
      docCode: z.string(),
      refNo: z.string().optional().default(""),
      docDate: z.string().optional().default(""),
      dueDate: z.string().nullable().optional(),
      outstandingAmount: z.number(),
      daysOverdue: z.number(),
    }),
  ),
});

function sanitizePhone(raw: string): string {
  const digits = (raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  // QNE Malaysia records may store Phone 1 with a local leading zero.
  if (digits.startsWith("0")) return `60${digits.replace(/^0+/, "")}`;
  return digits;
}

function pickCustomerPhone(record: Record<string, unknown>): string {
  const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const preferred = new Set([
    "whatsappno",
    "whatsappnumber",
    "whatsapp",
    "billingwhatsappno",
    "billingwhatsappnumber",
    "phone1",
    "phoneno1",
    "phoneone",
    "billingphone1",
    "billingphoneno1",
    "mobilephone",
    "mobileno",
    "mobilenumber",
    "mobile",
    "tel1",
    "telephone1",
    "contactno",
    "contactnumber",
    "phone",
    "phoneno",
    "phone2",
    "tel2",
  ]);
  const candidates: Array<{ score: number; value: string }> = [];

  const visit = (value: unknown, keyPath: string[], depth = 0) => {
    if (value == null || depth > 6) return;
    if (typeof value === "object") {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, [...keyPath, String(index)], depth + 1));
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...keyPath, key], depth + 1);
      }
      return;
    }

    const raw = String(value).trim();
    const phone = sanitizePhone(raw);
    if (phone.length < 8) return;

    const normalizedPath = keyPath.map(normalize);
    let score = 0;
    for (const key of normalizedPath) {
      if (preferred.has(key)) score = Math.max(score, 100);
      else if (key.includes("whatsapp")) score = Math.max(score, 90);
      else if (key.includes("phone") || key.includes("tel") || key.includes("mobile")) {
        score = Math.max(score, 70);
      }
    }
    if (score > 0) candidates.push({ score, value: phone });
  };

  visit(record, []);
  return candidates.sort((a, b) => b.score - a.score)[0]?.value ?? "";
}

async function fetchCustomerPhone(
  headers: { Authorization: string },
  data: z.infer<typeof WhatsappSchema>,
) {
  const detailRes = await fetch(`${QNE_BASE}/api/Customers/${data.customerId}`, { headers });
  if (detailRes.status === 401) throw new QneUnauthorizedError();
  if (!detailRes.ok) throw new Error(`Unable to load QNE customer (${detailRes.status}).`);
  const detailBody = (await detailRes.json()) as {
    code?: string;
    message?: string;
    data?: Record<string, unknown>;
  };
  if (detailBody.code !== "0000" || !detailBody.data) {
    throw new Error(detailBody.message || "Customer not found in QNE.");
  }

  const phoneFromDetail = pickCustomerPhone(detailBody.data);
  if (phoneFromDetail) return phoneFromDetail;

  const listUrl = new URL(`${QNE_BASE}/api/Customers/List`);
  listUrl.searchParams.set(
    "$filter",
    `id eq ${data.customerId} or code eq '${data.customerCode.replace(/'/g, "''")}'`,
  );
  listUrl.searchParams.set("$top", "3");
  const listRes = await fetch(listUrl, { headers });
  if (listRes.status === 401) throw new QneUnauthorizedError();
  if (!listRes.ok) return "";
  const listBody = (await listRes.json()) as {
    code?: string;
    data?: { value?: Array<Record<string, unknown>> };
  };
  if (listBody.code !== "0000") return "";
  for (const customer of listBody.data?.value ?? []) {
    const phone = pickCustomerPhone(customer);
    if (phone) return phone;
  }
  return "";
}

async function shortenUrl(longUrl: string): Promise<string> {
  try {
    const res = await fetch(
      `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`,
    );
    if (!res.ok) return longUrl;
    const text = (await res.text()).trim();
    if (text.startsWith("http")) return text;
    return longUrl;
  } catch {
    return longUrl;
  }
}

async function buildStatementPdf(opts: {
  companyHeaderLines: string[];
  companyName: string;
  customerName: string;
  customerCode: string;
  currency: string;
  invoices: Array<{
    docCode: string;
    refNo: string;
    docDate: string;
    dueDate: string | null | undefined;
    outstandingAmount: number;
    daysOverdue: number;
    items: InvoiceItem[];
  }>;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]); // A4 portrait
  const pageSize = page.getSize();
  const width = pageSize.width;
  const margin = 40;
  let y = pageSize.height - margin;

  const draw = (text: string, x: number, yy: number, size = 10, f = font, color = rgb(0, 0, 0)) =>
    page.drawText(text, { x, y: yy, size, font: f, color });

  const newPage = () => {
    page = doc.addPage([595, 842]);
    y = page.getSize().height - margin;
  };
  const ensure = (h: number) => {
    if (y - h < margin) newPage();
  };

  // Letterhead (from QNE Company Profile > Header)
  if (opts.companyHeaderLines.length > 0) {
    draw(opts.companyHeaderLines[0], margin, y, 14, bold);
    y -= 18;
    for (const line of opts.companyHeaderLines.slice(1)) {
      draw(line, margin, y, 9, font, rgb(0.3, 0.3, 0.3));
      y -= 12;
    }
  } else {
    draw(opts.companyName || "Overdue Statement", margin, y, 16, bold);
    y -= 22;
  }
  y -= 6;
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.8,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;

  draw("Statement of Overdue Invoices", margin, y, 12, bold, rgb(0.2, 0.2, 0.2));
  y -= 16;
  draw(`Customer: ${opts.customerName} (${opts.customerCode})`, margin, y, 11, bold);
  y -= 13;
  draw(`Generated: ${new Date().toLocaleString()}`, margin, y, 9, font, rgb(0.45, 0.45, 0.45));
  y -= 18;

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
      n,
    );

  let grandTotal = 0;
  for (const inv of opts.invoices) {
    ensure(40);
    // Invoice header band
    page.drawRectangle({
      x: margin - 4,
      y: y - 4,
      width: width - margin * 2 + 8,
      height: 16,
      color: rgb(0.93, 0.93, 0.96),
    });
    draw(`Invoice ${inv.docCode || "—"}`, margin, y, 10, bold);
    draw(`Date: ${inv.docDate || ""}`, margin + 170, y, 9, bold);
    draw(`Due: ${inv.dueDate || "—"}`, margin + 270, y, 9, bold);
    draw(`Days: ${inv.daysOverdue}`, margin + 365, y, 9, bold);
    const outStr = fmt(inv.outstandingAmount);
    const outW = bold.widthOfTextAtSize(outStr, 10);
    draw(outStr, width - margin - outW, y, 10, bold);
    y -= 16;
    if (inv.refNo) {
      ensure(11);
      draw(`Ref: ${inv.refNo}`, margin, y, 8, font, rgb(0.4, 0.4, 0.4));
      y -= 11;
    }

    // Item rows
    if (inv.items.length) {
      ensure(13);
      draw("Item", margin + 4, y, 8, bold, rgb(0.35, 0.35, 0.35));
      draw("Description", margin + 80, y, 8, bold, rgb(0.35, 0.35, 0.35));
      draw("Qty", margin + 310, y, 8, bold, rgb(0.35, 0.35, 0.35));
      draw("UOM", margin + 345, y, 8, bold, rgb(0.35, 0.35, 0.35));
      draw("Price", margin + 390, y, 8, bold, rgb(0.35, 0.35, 0.35));
      const amtHeader = "Amount";
      const ahw = bold.widthOfTextAtSize(amtHeader, 8);
      draw(amtHeader, width - margin - ahw, y, 8, bold, rgb(0.35, 0.35, 0.35));
      y -= 11;
      for (const it of inv.items) {
        ensure(11);
        draw((it.stockCode || "").slice(0, 14), margin + 4, y, 8);
        draw((it.description || "").slice(0, 40), margin + 80, y, 8);
        draw(it.qty ? String(it.qty) : "", margin + 310, y, 8);
        draw((it.uom || "").slice(0, 6), margin + 345, y, 8);
        draw(fmt(it.unitPrice), margin + 390, y, 8);
        const am = fmt(it.amount);
        const aw = font.widthOfTextAtSize(am, 8);
        draw(am, width - margin - aw, y, 8);
        y -= 11;
      }
    } else {
      ensure(11);
      draw("(no line items)", margin + 4, y, 8, font, rgb(0.55, 0.55, 0.55));
      y -= 11;
    }
    y -= 10;
    grandTotal += inv.outstandingAmount;
  }

  ensure(50);
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: rgb(0.6, 0.6, 0.6),
  });
  y -= 16;
  const totalLabel = `Total Outstanding (${opts.currency || ""})`;
  draw(totalLabel, margin, y, 11, bold);
  const totalStr = fmt(grandTotal);
  const totalWidth = bold.widthOfTextAtSize(totalStr, 11);
  draw(totalStr, width - margin - totalWidth, y, 11, bold);

  y -= 24;
  ensure(24);
  draw(
    "Kindly arrange payment for the above outstanding invoices at your earliest convenience.",
    margin,
    y,
    9,
    font,
    rgb(0.35, 0.35, 0.35),
  );
  y -= 12;
  draw("Thank you for your prompt attention.", margin, y, 9, font, rgb(0.35, 0.35, 0.35));

  return await doc.save();
}

export const sendOverdueViaWhatsApp = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => WhatsappSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{ phone: string; shortUrl: string; longUrl: string; customerName: string }> => {
      const headers = { Authorization: `Bearer ${data.token}` };

      // 1. Fetch customer for phone number.
      const phone = await fetchCustomerPhone(headers, data);
      if (!phone)
        throw new Error(
          "This customer has no phone number in QNE. Add a WhatsApp No. or Phone 1 in Customer Maintenance.",
        );

      // 2. Generate PDF statement.
      const pdfBytes = await buildStatementPdf({
        companyName: data.companyName,
        customerName: data.customerName,
        customerCode: data.customerCode,
        currency: data.currency,
        invoices: data.invoices.map((i) => ({
          docCode: i.docCode,
          refNo: i.refNo,
          docDate: i.docDate,
          dueDate: i.dueDate ?? null,
          outstandingAmount: i.outstandingAmount,
          daysOverdue: i.daysOverdue,
        })),
      });

      // 3. Upload to Lovable Cloud storage.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const safeCode = (data.customerCode || String(data.customerId)).replace(
        /[^A-Za-z0-9_-]/g,
        "_",
      );
      const objectPath = `${safeCode}/overdue-${Date.now()}.pdf`;
      const { error: uploadErr } = await supabaseAdmin.storage
        .from("overdue-statements")
        .upload(objectPath, pdfBytes, {
          contentType: "application/pdf",
          upsert: true,
        });
      if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

      // 4. Long-lived signed URL (1 year).
      const { data: signed, error: signedErr } = await supabaseAdmin.storage
        .from("overdue-statements")
        .createSignedUrl(objectPath, 60 * 60 * 24 * 365);
      if (signedErr || !signed?.signedUrl)
        throw new Error(`Could not sign URL: ${signedErr?.message || "unknown"}`);

      // 5. Shorten via is.gd.
      const shortUrl = await shortenUrl(signed.signedUrl);

      return {
        phone,
        shortUrl,
        longUrl: signed.signedUrl,
        customerName: data.customerName,
      };
    },
  );
