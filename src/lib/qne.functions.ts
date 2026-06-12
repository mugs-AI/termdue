import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const QNE_BASE = "https://openapi.account.qne.cloud";

const InputSchema = z.object({
  apiKey: z.string().uuid({ message: "QNE API key must be a valid GUID" }),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type OverdueInvoice = {
  id: string;
  docCode: string;
  docDate: string;
  dueDate: string | null;
  customerCode: string;
  customerName: string;
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

export const fetchOverdueInvoices = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<OverdueResult> => {
    const jwt = await getJwt(data.apiKey);
    const today = new Date().toISOString().slice(0, 10);

    // QNE enforces visibility per credential. We just query overdue invoices
    // within the user's date range. dueDate < today AND outstandingAmount > 0.
    const filter = [
      `isCancelled eq false`,
      `outstandingAmount gt 0`,
      `dueDate lt ${today}`,
      `docDate ge ${data.fromDate}`,
      `docDate le ${data.toDate}`,
    ].join(" and ");

    const url = new URL(`${QNE_BASE}/api/SalesInvoices/List`);
    url.searchParams.set("$filter", filter);
    url.searchParams.set("$orderby", "dueDate asc");
    url.searchParams.set("$top", "500");

    const [invRes, companyName] = await Promise.all([
      fetch(url.toString(), { headers: { Authorization: `Bearer ${jwt}` } }),
      getCompanyName(jwt),
    ]);

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
        docCode: String(r.docCode ?? ""),
        docDate: String(r.docDate ?? ""),
        dueDate,
        customerCode: String(r.customerCode ?? ""),
        customerName: String(r.customerName ?? ""),
        netTotalAmount: Number(r.netTotalAmount ?? 0),
        outstandingAmount: Number(r.outstandingAmount ?? 0),
        currencyCode: String(r.currencyCode ?? ""),
        daysOverdue,
      };
    });

    const totalOutstanding = invoices.reduce((sum, i) => sum + i.outstandingAmount, 0);
    const currency = invoices[0]?.currencyCode ?? "";

    return {
      fetchedAt: new Date().toISOString(),
      fromDate: data.fromDate,
      toDate: data.toDate,
      totalCount: body.data.count ?? invoices.length,
      totalOutstanding,
      currency,
      invoices,
      companyName,
    };
  });
