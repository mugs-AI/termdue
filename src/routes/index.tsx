import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overdue Invoices Dashboard" },
      { name: "description", content: "Read-only overdue sales invoices dashboard powered by N3." },
    ],
  }),
  component: SignInPage,
});

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function SignInPage() {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Auto-launch flow: when N3 hands off to this app, it appends the API key
  // to the launch URL (e.g. ?api-key=... or ?apiKey=...). We capture it,
  // stash it in sessionStorage, and jump straight to the dashboard so the
  // user never sees this sign-in screen.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);

    // N3 launches the app with a ready-made JWT in `?token=...` — use it directly.
    const jwtFromUrl =
      url.searchParams.get("token") ||
      url.searchParams.get("access_token") ||
      url.searchParams.get("jwt") ||
      "";
    const looksLikeJwt = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwtFromUrl.trim());

    if (jwtFromUrl && looksLikeJwt) {
      sessionStorage.setItem("qne_jwt", jwtFromUrl.trim());
      sessionStorage.removeItem("qne_api_key");
      url.searchParams.delete("token");
      url.searchParams.delete("access_token");
      url.searchParams.delete("jwt");
      window.history.replaceState({}, "", url.pathname + url.search);
      navigate({ to: "/dashboard" });
      return;
    }

    // Fallback: also accept an API-key GUID (older marketplace handoff or dev).
    const keyFromUrl =
      url.searchParams.get("api-key") ||
      url.searchParams.get("apiKey") ||
      url.searchParams.get("apikey") ||
      "";

    if (keyFromUrl && GUID.test(keyFromUrl.trim())) {
      sessionStorage.setItem("qne_api_key", keyFromUrl.trim());
      url.searchParams.delete("api-key");
      url.searchParams.delete("apiKey");
      url.searchParams.delete("apikey");
      window.history.replaceState({}, "", url.pathname + url.search);
      navigate({ to: "/dashboard" });
      return;
    }

    if (sessionStorage.getItem("qne_jwt") || sessionStorage.getItem("qne_api_key")) {
      navigate({ to: "/dashboard" });
    }
  }, [navigate]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!GUID.test(trimmed)) {
      setError("That doesn't look like an N3 API key. It should be a GUID.");
      return;
    }
    sessionStorage.setItem("qne_api_key", trimmed);
    navigate({ to: "/dashboard" });
  }

  const isProd = import.meta.env.PROD;

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Overdue Invoices
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {isProd
              ? "Waiting for N3 to launch this app with your API key…"
              : "Launch from N3 — the API key is passed automatically. You can also paste a key manually below (dev only)."}
          </p>
        </div>

        {!isProd && (
          <form
            onSubmit={onSubmit}
            className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor="key" className="text-sm font-medium text-foreground">
                N3 API key (dev only)
              </label>
              <input
                id="key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError(null);
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                In production, N3 launches this app with <code>?api-key=…</code> appended to the URL.
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Continue
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
