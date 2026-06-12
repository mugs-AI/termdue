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
    const fromUrl =
      url.searchParams.get("api-key") ||
      url.searchParams.get("apiKey") ||
      url.searchParams.get("apikey") ||
      "";

    if (fromUrl && GUID.test(fromUrl.trim())) {
      sessionStorage.setItem("qne_api_key", fromUrl.trim());
      // Strip the key from the address bar so it isn't shoulder-surfed or logged.
      url.searchParams.delete("api-key");
      url.searchParams.delete("apiKey");
      url.searchParams.delete("apikey");
      window.history.replaceState({}, "", url.pathname + url.search);
      navigate({ to: "/dashboard" });
      return;
    }

    if (sessionStorage.getItem("qne_api_key")) {
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

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Overdue Invoices
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Launch this app from N3 — your API key is passed automatically and
            N3 enforces which companies and invoices you can see. You can also
            paste a key manually below.
          </p>
        </div>
        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4"
        >
          <div className="space-y-2">
            <label htmlFor="key" className="text-sm font-medium text-foreground">
              N3 API key
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
      </div>
    </main>
  );
}
