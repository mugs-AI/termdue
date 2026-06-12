import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overdue Invoices Dashboard" },
      { name: "description", content: "Read-only overdue sales invoices dashboard powered by QNE." },
    ],
  }),
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && sessionStorage.getItem("qne_api_key")) {
      navigate({ to: "/dashboard" });
    }
  }, [navigate]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = apiKey.trim();
    const guid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!guid.test(trimmed)) {
      setError("That doesn't look like a QNE API key. It should be a GUID.");
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
            Sign in with your QNE API key. Your key is held only in this browser tab and is
            sent to QNE on every refresh — QNE enforces which companies and invoices you see.
          </p>
        </div>
        <form
          onSubmit={onSubmit}
          className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4"
        >
          <div className="space-y-2">
            <label htmlFor="key" className="text-sm font-medium text-foreground">
              QNE API key
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
              Find it in QNE → Marketplace → My Apps → your app.
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
