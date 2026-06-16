import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList } from "recharts";
import {
  fetchOverdueInvoices,
  getAiInsights,
  exchangeApiKey,
  refreshSession,
  toggleCustomerSuspension,
  sendOverdueViaWhatsApp,
  type OverdueInvoice,
  type OverdueResult,
} from "@/lib/qne.functions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Overdue Invoices · Dashboard" },
      { name: "description", content: "Live overdue sales invoices pulled from QNE." },
    ],
  }),
  component: DashboardPage,
  errorComponent: ({ error, reset }) => {
    const router = useRouter();
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-foreground">Couldn't load the dashboard</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  },
});

const N3_INVOICE_URL = (id: string) => `https://n3.qne.cloud/#/sale/inv/detail/${id}`;
const N3_RECEIVE_PAYMENT_URL = (customerId: number) =>
  `https://n3.qne.cloud/#/ar/or/detail/0?customerId=${encodeURIComponent(customerId)}`;

const PALETTE = [
  "#6366f1",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#8b5cf6",
  "#ef4444",
  "#84cc16",
  "#0ea5e9",
  "#f97316",
  "#14b8a6",
  "#a855f7",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#d946ef",
  "#f43f5e",
  "#65a30d",
  "#0284c7",
  "#fb923c",
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function monthsAgoISO(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function DashboardPage() {
  const navigate = useNavigate();
  const fetchFn = useServerFn(fetchOverdueInvoices);
  const insightsFn = useServerFn(getAiInsights);
  const exchangeFn = useServerFn(exchangeApiKey);
  const refreshFn = useServerFn(refreshSession);
  const toggleCustomerFn = useServerFn(toggleCustomerSuspension);
  const whatsappFn = useServerFn(sendOverdueViaWhatsApp);

  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(monthsAgoISO(12));
  const [toDate, setToDate] = useState(todayISO());
  const [salesperson, setSalesperson] = useState("");
  const [termCode, setTermCode] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [topCount, setTopCount] = useState(20);
  const [customerStatusOverrides, setCustomerStatusOverrides] = useState<Record<number, 0 | 3>>({});

  // Run a fetch with one transparent JWT refresh on 401.
  async function fetchWithRefresh(vars: {
    fromDate: string;
    toDate: string;
    salesperson: string;
    termCode: string;
  }): Promise<OverdueResult> {
    const current = token ?? sessionStorage.getItem("qne_jwt");
    if (!current) throw new Error("Not signed in");
    try {
      return (await fetchFn({ data: { ...vars, token: current } })) as OverdueResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/QneUnauthorized|session expired|401/i.test(msg)) throw e;
      // Refresh once, retry once.
      const { token: fresh } = (await refreshFn({ data: { token: current } })) as { token: string };
      sessionStorage.setItem("qne_jwt", fresh);
      setToken(fresh);
      return (await fetchFn({ data: { ...vars, token: fresh } })) as OverdueResult;
    }
  }

  const mutation = useMutation({
    mutationFn: (vars: {
      fromDate: string;
      toDate: string;
      salesperson: string;
      termCode: string;
    }) => fetchWithRefresh(vars),
  });

  const insights = useMutation({
    mutationFn: (vars: {
      summary: {
        totalCount: number;
        totalOutstanding: number;
        currency: string;
        topCustomers: { customerName: string; outstanding: number; count: number }[];
        bucketsByAge: Record<string, number>;
        oldestDays: number;
      };
    }) => insightsFn({ data: vars }) as Promise<{ tips: string[] }>,
  });

  const customerStatusMutation = useMutation({
    mutationFn: async (customerId: number) => {
      const current = token ?? sessionStorage.getItem("qne_jwt");
      if (!current) throw new Error("Not signed in");
      try {
        return await toggleCustomerFn({ data: { token: current, customerId } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/QneUnauthorized|session expired|401/i.test(message)) throw error;
        const { token: fresh } = await refreshFn({ data: { token: current } });
        sessionStorage.setItem("qne_jwt", fresh);
        setToken(fresh);
        return toggleCustomerFn({ data: { token: fresh, customerId } });
      }
    },
    onSuccess: ({ status }, customerId) => {
      setCustomerStatusOverrides((current) => ({ ...current, [customerId]: status }));
    },
  });

  const [whatsappPendingId, setWhatsappPendingId] = useState<number | null>(null);
  const whatsappMutation = useMutation({
    mutationFn: async (vars: {
      customerId: number;
      customerCode: string;
      customerName: string;
      currency: string;
      companyName: string;
      invoices: OverdueInvoice[];
    }) => {
      const current = token ?? sessionStorage.getItem("qne_jwt");
      if (!current) throw new Error("Not signed in");
      const payload = {
        token: current,
        customerId: vars.customerId,
        customerCode: vars.customerCode,
        customerName: vars.customerName,
        currency: vars.currency,
        companyName: vars.companyName,
        invoices: vars.invoices.map((i) => ({
          docCode: i.docCode,
          refNo: i.refNo,
          docDate: i.docDate,
          dueDate: i.dueDate,
          outstandingAmount: i.outstandingAmount,
          daysOverdue: i.daysOverdue,
        })),
      };
      try {
        return await whatsappFn({ data: payload });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!/QneUnauthorized|session expired|401/i.test(msg)) throw error;
        const { token: fresh } = await refreshFn({ data: { token: current } });
        sessionStorage.setItem("qne_jwt", fresh);
        setToken(fresh);
        return whatsappFn({ data: { ...payload, token: fresh } });
      }
    },
    onMutate: (vars) => setWhatsappPendingId(vars.customerId),
    onSettled: () => setWhatsappPendingId(null),
    onSuccess: ({ phone, shortUrl, customerName }) => {
      const msg = `Hi ${customerName}, here is your overdue invoices statement: ${shortUrl}\n\nKindly arrange payment at your earliest convenience. Thank you.`;
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });


  // Bootstrap: accept a JWT directly from N3 (`?token=...`), fall back to an
  // API key in the URL or sessionStorage (which we exchange once for a JWT),
  // then use the JWT for every subsequent call.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    const url = new URL(window.location.href);
    const jwtRe = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

    // 1. JWT in the URL — preferred handoff from N3.
    const jwtFromUrl = (
      url.searchParams.get("token") ||
      url.searchParams.get("access_token") ||
      url.searchParams.get("jwt") ||
      ""
    ).trim();
    if (jwtFromUrl && jwtRe.test(jwtFromUrl)) {
      sessionStorage.setItem("qne_jwt", jwtFromUrl);
      sessionStorage.removeItem("qne_api_key");
      url.searchParams.delete("token");
      url.searchParams.delete("access_token");
      url.searchParams.delete("jwt");
      window.history.replaceState({}, "", url.pathname + url.search);
      setToken(jwtFromUrl);
      return;
    }

    // 2. JWT already in this session.
    const existingJwt = sessionStorage.getItem("qne_jwt");
    if (existingJwt) {
      setToken(existingJwt);
      return;
    }

    // 3. API key — exchange once for a JWT, then discard the key.
    const guid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const keyFromUrl =
      url.searchParams.get("api-key") ||
      url.searchParams.get("apiKey") ||
      url.searchParams.get("apikey") ||
      "";
    const fromStorage = sessionStorage.getItem("qne_api_key") ?? "";
    const apiKey = (keyFromUrl || fromStorage).trim();

    if (!apiKey || !guid.test(apiKey)) {
      navigate({ to: "/" });
      return;
    }

    if (keyFromUrl) {
      url.searchParams.delete("api-key");
      url.searchParams.delete("apiKey");
      url.searchParams.delete("apikey");
      window.history.replaceState({}, "", url.pathname + url.search);
    }

    (async () => {
      try {
        const { token: jwt } = (await exchangeFn({ data: { apiKey } })) as { token: string };
        if (cancelled) return;
        sessionStorage.setItem("qne_jwt", jwt);
        sessionStorage.removeItem("qne_api_key");
        setToken(jwt);
      } catch (e) {
        if (cancelled) return;
        setAuthError(e instanceof Error ? e.message : "Failed to authenticate with N3.");
        sessionStorage.removeItem("qne_api_key");
        sessionStorage.removeItem("qne_jwt");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [exchangeFn, navigate]);

  useEffect(() => {
    if (!token) return;
    mutation.mutate({ fromDate, toDate, salesperson, termCode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, fromDate, toDate, salesperson, termCode]);

  const data = mutation.data;
  const loading = mutation.isPending;

  const customerGroups = useMemo(() => {
    if (!data) return [];
    const map = new Map<
      string,
      {
        customerId: number | null;
        code: string;
        name: string;
        invoices: OverdueInvoice[];
        total: number;
      }
    >();
    for (const inv of data.invoices) {
      const key = inv.customerCode || inv.customerName || "—";
      const g = map.get(key) ?? {
        customerId: inv.customerId,
        code: inv.customerCode,
        name: inv.customerName,
        invoices: [],
        total: 0,
      };
      g.invoices.push(inv);
      g.total += inv.outstandingAmount;
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data]);

  const topCustomers = useMemo(() => customerGroups.slice(0, topCount), [customerGroups, topCount]);

  function refresh() {
    if (token) mutation.mutate({ fromDate, toDate, salesperson, termCode });
  }
  function signOut() {
    sessionStorage.removeItem("qne_api_key");
    sessionStorage.removeItem("qne_jwt");
    navigate({ to: "/" });
  }

  function runInsights() {
    if (!data) return;
    const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    for (const inv of data.invoices) {
      const d = inv.daysOverdue;
      if (d <= 30) buckets["0-30"] += inv.outstandingAmount;
      else if (d <= 60) buckets["31-60"] += inv.outstandingAmount;
      else if (d <= 90) buckets["61-90"] += inv.outstandingAmount;
      else buckets["90+"] += inv.outstandingAmount;
    }
    const oldest = data.invoices.length ? Math.max(...data.invoices.map((i) => i.daysOverdue)) : 0;
    insights.mutate({
      summary: {
        totalCount: data.invoices.length,
        totalOutstanding: data.totalOutstanding,
        currency: data.currency,
        topCustomers: customerGroups.slice(0, 10).map((g) => ({
          customerName: g.name,
          outstanding: g.total,
          count: g.invoices.length,
        })),
        bucketsByAge: buckets,
        oldestDays: oldest,
      },
    });
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight bg-gradient-to-r from-indigo-500 to-pink-500 bg-clip-text text-transparent">
              Overdue Invoices
            </h1>
            <p className="text-xs text-muted-foreground">
              {data?.companyName ? `Connected to ${data.companyName}` : "Live from QNE"}
            </p>
          </div>
          <button
            onClick={signOut}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-6 py-6 space-y-6">
        <Filters
          fromDate={fromDate}
          toDate={toDate}
          salesperson={salesperson}
          termCode={termCode}
          salespeople={data?.salespeople ?? []}
          termCodes={data?.termCodes ?? []}
          onChange={(p) => {
            if (p.fromDate !== undefined) setFromDate(p.fromDate);
            if (p.toDate !== undefined) setToDate(p.toDate);
            if (p.salesperson !== undefined) setSalesperson(p.salesperson);
            if (p.termCode !== undefined) setTermCode(p.termCode);
          }}
          onRefresh={refresh}
          loading={loading}
          fetchedAt={data?.fetchedAt ?? null}
        />

        {authError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {authError}
          </div>
        )}

        {mutation.isError && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          >
            {(mutation.error as Error).message}
          </div>
        )}

        <StatsGrid data={data} loading={loading} />

        <AiInsights
          onRun={runInsights}
          loading={insights.isPending}
          tips={insights.data?.tips}
          error={insights.isError ? (insights.error as Error).message : null}
          disabled={!data || data.invoices.length === 0}
        />

        <TopCustomersChart
          top={topCustomers}
          count={topCount}
          onCountChange={setTopCount}
          currency={data?.currency ?? ""}
        />

        <CustomerGroups
          groups={customerGroups}
          expanded={expanded}
          toggle={(k) => setExpanded((e) => ({ ...e, [k]: !e[k] }))}
          loading={loading && !data}
          currency={data?.currency ?? ""}
          statuses={data?.customerStatuses ?? {}}
          statusOverrides={customerStatusOverrides}
          statusPendingId={
            customerStatusMutation.isPending ? customerStatusMutation.variables : undefined
          }
          statusError={
            customerStatusMutation.isError ? (customerStatusMutation.error as Error).message : null
          }
          onToggleStatus={(customerId) => customerStatusMutation.mutate(customerId)}
          companyName={data?.companyName ?? ""}
          whatsappPendingId={whatsappPendingId}
          whatsappError={
            whatsappMutation.isError ? (whatsappMutation.error as Error).message : null
          }
          onSendWhatsapp={(g) =>
            whatsappMutation.mutate({
              customerId: g.customerId as number,
              customerCode: g.code,
              customerName: g.name,
              currency: g.invoices[0]?.currencyCode || data?.currency || "",
              companyName: data?.companyName ?? "",
              invoices: g.invoices,
            })
          }
        />
      </section>
    </main>
  );
}

function Filters({
  fromDate,
  toDate,
  salesperson,
  termCode,
  salespeople,
  termCodes,
  onChange,
  onRefresh,
  loading,
  fetchedAt,
}: {
  fromDate: string;
  toDate: string;
  salesperson: string;
  termCode: string;
  salespeople: string[];
  termCodes: string[];
  onChange: (
    p: Partial<{ fromDate: string; toDate: string; salesperson: string; termCode: string }>,
  ) => void;
  onRefresh: () => void;
  loading: boolean;
  fetchedAt: string | null;
}) {
  const stamp = useMemo(() => {
    if (!fetchedAt) return null;
    try {
      return new Date(fetchedAt).toLocaleString();
    } catch {
      return fetchedAt;
    }
  }, [fetchedAt]);

  const inputCls = "rounded-md border border-input bg-background px-3 py-1.5 text-sm";

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-end gap-4 shadow-sm">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">From</label>
        <input
          type="date"
          value={fromDate}
          max={toDate}
          onChange={(e) => onChange({ fromDate: e.target.value })}
          className={inputCls}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">To</label>
        <input
          type="date"
          value={toDate}
          min={fromDate}
          onChange={(e) => onChange({ toDate: e.target.value })}
          className={inputCls}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Salesperson</label>
        <select
          value={salesperson}
          onChange={(e) => onChange({ salesperson: e.target.value })}
          className={inputCls}
        >
          <option value="">All</option>
          {salespeople.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">Term Code</label>
        <select
          value={termCode}
          onChange={(e) => onChange({ termCode: e.target.value })}
          className={inputCls}
        >
          <option value="">All</option>
          {termCodes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="rounded-md bg-gradient-to-r from-indigo-500 to-pink-500 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {loading ? "Refreshing…" : "Refresh from QNE"}
      </button>
      <div className="ml-auto text-xs text-muted-foreground">
        {loading
          ? "Pulling live data from QNE…"
          : stamp
            ? `Last refreshed: ${stamp}`
            : "Not yet refreshed"}
      </div>
    </div>
  );
}

function fmtMoney(n: number, ccy: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: ccy || "USD",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${ccy} ${n.toFixed(2)}`;
  }
}

function StatsGrid({ data, loading }: { data: OverdueResult | undefined; loading: boolean }) {
  const items = [
    {
      label: "Overdue invoices",
      value: data ? data.invoices.length.toLocaleString() : "—",
      grad: "from-indigo-500 to-blue-500",
    },
    {
      label: "Total overdue amount",
      value: data ? fmtMoney(data.totalOutstanding, data.currency) : "—",
      grad: "from-pink-500 to-rose-500",
    },
    {
      label: "Oldest days overdue",
      value:
        data && data.invoices.length
          ? `${Math.max(...data.invoices.map((i) => i.daysOverdue))} days`
          : "—",
      grad: "from-amber-500 to-orange-500",
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {items.map((it) => (
        <div
          key={it.label}
          className={`rounded-xl p-5 text-white bg-gradient-to-br ${it.grad} shadow-md`}
        >
          <div className="text-xs uppercase tracking-wide opacity-90">{it.label}</div>
          <div className="mt-2 text-2xl font-semibold">{loading && !data ? "…" : it.value}</div>
        </div>
      ))}
    </div>
  );
}

function AiInsights({
  onRun,
  loading,
  tips,
  error,
  disabled,
}: {
  onRun: () => void;
  loading: boolean;
  tips: string[] | undefined;
  error: string | null;
  disabled: boolean;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [tips]);
  const total = tips?.length ?? 0;
  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-violet-500/10 via-card to-pink-500/10 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">AI Insight Tips</h2>
          <p className="text-xs text-muted-foreground">
            5 quick, actionable tips from your overdue snapshot.
          </p>
        </div>
        <button
          onClick={onRun}
          disabled={disabled || loading}
          className="rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {loading ? "Thinking…" : tips ? "Regenerate" : "Generate"}
        </button>
      </div>
      {error && <div className="mt-3 text-sm text-destructive">{error}</div>}
      {tips && total > 0 && (
        <div className="mt-4">
          <div className="rounded-lg border border-border bg-card/70 p-4 text-sm text-foreground min-h-[88px] flex items-start gap-2">
            <span className="text-violet-500 shrink-0">✦</span>
            <span className="min-w-0">{tips[index]}</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Tip {index + 1} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0}
              >
                Back
              </Button>
              <Button
                size="sm"
                onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
                disabled={index >= total - 1}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TopCustomersChart({
  top,
  count,
  onCountChange,
  currency,
}: {
  top: { code: string; name: string; total: number }[];
  count: number;
  onCountChange: (count: number) => void;
  currency: string;
}) {
  if (top.length === 0) return null;
  const chartData = top.map((g) => ({
    name: g.name.length > 22 ? g.name.slice(0, 22) + "…" : g.name,
    total: Math.round(g.total * 100) / 100,
  }));
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Top {count} customers by overdue
          </h2>
          <p className="text-xs text-muted-foreground">Total outstanding ({currency || "—"})</p>
        </div>
        <Select value={String(count)} onValueChange={(value) => onCountChange(Number(value))}>
          <SelectTrigger className="w-28" aria-label="Number of customers to display">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[10, 20, 30, 50].map((option) => (
              <SelectItem key={option} value={String(option)}>
                Top {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-full" style={{ height: Math.max(320, count * 26) }}>
        <ResponsiveContainer>
          <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 60, top: 4, bottom: 4 }}>
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis dataKey="name" type="category" width={170} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v: number) => fmtMoney(v, currency)}
              contentStyle={{ borderRadius: 8, fontSize: 12 }}
            />
            <Bar dataKey="total" radius={[0, 6, 6, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
              ))}
              <LabelList
                dataKey="name"
                position="insideLeft"
                fill="#ffffff"
                fontSize={11}
                style={{ pointerEvents: "none", fontWeight: 600 }}
              />
              <LabelList
                dataKey="total"
                position="right"
                fontSize={11}
                formatter={(v: number) => fmtMoney(v, currency)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type CustomerGroup = {
  customerId: number | null;
  code: string;
  name: string;
  invoices: OverdueInvoice[];
  total: number;
};

function CustomerGroups({
  groups,
  expanded,
  toggle,
  loading,
  currency,
  statuses,
  statusOverrides,
  statusPendingId,
  statusError,
  onToggleStatus,
  whatsappPendingId,
  whatsappError,
  onSendWhatsapp,
}: {
  groups: CustomerGroup[];
  expanded: Record<string, boolean>;
  toggle: (k: string) => void;
  loading: boolean;
  currency: string;
  statuses: Record<string, number>;
  statusOverrides: Record<number, 0 | 3>;
  statusPendingId: number | undefined;
  statusError: string | null;
  onToggleStatus: (customerId: number) => void;
  companyName: string;
  whatsappPendingId: number | null;
  whatsappError: string | null;
  onSendWhatsapp: (g: CustomerGroup) => void;
}) {
  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        Loading overdue invoices from QNE…
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No overdue invoices in this range. 🎉
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
      <div className="px-5 py-3 border-b border-border bg-muted/40">
        <h2 className="text-base font-semibold text-foreground">Overdue by customer</h2>
        <p className="text-xs text-muted-foreground">
          Expand invoices, manage customer status, or start a payment in N3.
        </p>
        {statusError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {statusError}
          </p>
        )}
        {whatsappError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            WhatsApp: {whatsappError}
          </p>
        )}
      </div>
      <ul className="divide-y divide-border">
        {groups.map((g, idx) => {
          const key = g.code || g.name;
          const open = !!expanded[key];
          const accent = PALETTE[idx % PALETTE.length];
          const suspended =
            g.customerId !== null &&
            (statusOverrides[g.customerId] ?? statuses[String(g.customerId)]) === 3;
          return (
            <li key={key}>
              <div className="px-5 py-3 hover:bg-accent/40">
                <div className="flex items-center gap-3">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: accent }}
                  />
                  <Button
                    variant="ghost"
                    className="h-auto min-w-0 flex-1 justify-start px-0 py-0 text-left hover:bg-transparent"
                    onClick={() => toggle(key)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-foreground">{g.name || "(no name)"}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{g.code}</span>
                    </span>
                    <span
                      className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                    >
                      ›
                    </span>
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-[22px]">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{g.invoices.length} inv</span>
                    <span className="tabular-nums font-semibold text-foreground">
                      {fmtMoney(g.total, g.invoices[0]?.currencyCode || currency)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant={suspended ? "secondary" : "destructive"}
                      disabled={g.customerId === null || statusPendingId === g.customerId}
                      onClick={() => g.customerId !== null && onToggleStatus(g.customerId)}
                      title={g.customerId === null ? "Customer ID is unavailable" : undefined}
                    >
                      {statusPendingId === g.customerId
                        ? "Updating…"
                        : suspended
                          ? "Activate"
                          : "Suspend"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      asChild={g.customerId !== null}
                      disabled={g.customerId === null}
                    >
                      {g.customerId !== null ? (
                        <a
                          href={N3_RECEIVE_PAYMENT_URL(g.customerId)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Receive payment ↗
                        </a>
                      ) : (
                        <span>Receive payment</span>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
              {open && (
                <div className="overflow-x-auto bg-muted/20">
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="text-left">
                        <th className="px-5 py-2 font-medium">Invoice</th>
                        <th className="px-3 py-2 font-medium">Ref No</th>
                        <th className="px-3 py-2 font-medium">Invoice date</th>
                        <th className="px-3 py-2 font-medium">Due date</th>
                        <th className="px-3 py-2 font-medium">Salesperson</th>
                        <th className="px-3 py-2 font-medium">Term</th>
                        <th className="px-3 py-2 font-medium text-right">Days</th>
                        <th className="px-3 py-2 font-medium text-right">Outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.invoices.map((inv) => (
                        <tr key={inv.id} className="border-t border-border hover:bg-accent/30">
                          <td className="px-5 py-2">
                            <a
                              href={N3_INVOICE_URL(inv.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-primary hover:underline"
                              title="Open in N3"
                            >
                              {inv.docCode} ↗
                            </a>
                          </td>
                          <td className="px-3 py-2 text-foreground">{inv.refNo || "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">{inv.docDate}</td>
                          <td className="px-3 py-2 text-muted-foreground">{inv.dueDate ?? "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {inv.salespersonCode || "—"}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{inv.termCode || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <span
                              className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                                inv.daysOverdue > 90
                                  ? "bg-red-100 text-red-700"
                                  : inv.daysOverdue > 60
                                    ? "bg-orange-100 text-orange-700"
                                    : inv.daysOverdue > 30
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              {inv.daysOverdue}d
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-foreground">
                            {fmtMoney(inv.outstandingAmount, inv.currencyCode || currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
