import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fetchOverdueInvoices, type OverdueResult } from "@/lib/qne.functions";

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

  const [apiKey, setApiKey] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(monthsAgoISO(12));
  const [toDate, setToDate] = useState(todayISO());

  const mutation = useMutation({
    mutationFn: (vars: { apiKey: string; fromDate: string; toDate: string }) =>
      fetchFn({ data: vars }) as Promise<OverdueResult>,
  });

  // Read key on mount; redirect to sign-in if missing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const k = sessionStorage.getItem("qne_api_key");
    if (!k) {
      navigate({ to: "/" });
      return;
    }
    setApiKey(k);
  }, [navigate]);

  // Pull fresh data on first load and whenever the range changes.
  useEffect(() => {
    if (!apiKey) return;
    mutation.mutate({ apiKey, fromDate, toDate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, fromDate, toDate]);

  const data = mutation.data;
  const loading = mutation.isPending;

  function refresh() {
    if (apiKey) mutation.mutate({ apiKey, fromDate, toDate });
  }
  function signOut() {
    sessionStorage.removeItem("qne_api_key");
    navigate({ to: "/" });
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
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

      <section className="mx-auto max-w-6xl px-6 py-6 space-y-6">
        <Filters
          fromDate={fromDate}
          toDate={toDate}
          onChange={(f, t) => {
            setFromDate(f);
            setToDate(t);
          }}
          onRefresh={refresh}
          loading={loading}
          fetchedAt={data?.fetchedAt ?? null}
        />

        {mutation.isError && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {(mutation.error as Error).message}
          </div>
        )}

        <StatsGrid data={data} loading={loading} />
        <InvoiceTable data={data} loading={loading} />
      </section>
    </main>
  );
}

function Filters({
  fromDate,
  toDate,
  onChange,
  onRefresh,
  loading,
  fetchedAt,
}: {
  fromDate: string;
  toDate: string;
  onChange: (from: string, to: string) => void;
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

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">From (invoice date)</label>
        <input
          type="date"
          value={fromDate}
          max={toDate}
          onChange={(e) => onChange(e.target.value, toDate)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted-foreground">To (invoice date)</label>
        <input
          type="date"
          value={toDate}
          min={fromDate}
          onChange={(e) => onChange(fromDate, e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
      >
        {loading ? "Refreshing…" : "Refresh from QNE"}
      </button>
      <div className="ml-auto text-xs text-muted-foreground">
        {loading
          ? "Pulling live data from QNE…"
          : stamp
            ? `Last refreshed from QNE: ${stamp}`
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
    },
    {
      label: "Total overdue amount",
      value: data ? fmtMoney(data.totalOutstanding, data.currency) : "—",
    },
    {
      label: "Oldest days overdue",
      value:
        data && data.invoices.length
          ? `${Math.max(...data.invoices.map((i) => i.daysOverdue))} days`
          : "—",
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-border bg-card p-5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{it.label}</div>
          <div className="mt-2 text-2xl font-semibold text-foreground">
            {loading && !data ? "…" : it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function InvoiceTable({ data, loading }: { data: OverdueResult | undefined; loading: boolean }) {
  if (loading && !data) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        Loading overdue invoices from QNE…
      </div>
    );
  }
  if (!data) return null;
  if (data.invoices.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No overdue invoices in this range. 🎉
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">Invoice</th>
              <th className="px-4 py-2 font-medium">Customer</th>
              <th className="px-4 py-2 font-medium">Invoice date</th>
              <th className="px-4 py-2 font-medium">Due date</th>
              <th className="px-4 py-2 font-medium text-right">Days overdue</th>
              <th className="px-4 py-2 font-medium text-right">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((inv) => (
              <tr key={inv.id} className="border-t border-border">
                <td className="px-4 py-2 font-medium text-foreground">{inv.docCode}</td>
                <td className="px-4 py-2 text-foreground">
                  <div>{inv.customerName}</div>
                  <div className="text-xs text-muted-foreground">{inv.customerCode}</div>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{inv.docDate}</td>
                <td className="px-4 py-2 text-muted-foreground">{inv.dueDate ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums text-foreground">{inv.daysOverdue}</td>
                <td className="px-4 py-2 text-right tabular-nums font-medium text-foreground">
                  {fmtMoney(inv.outstandingAmount, inv.currencyCode || data.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
