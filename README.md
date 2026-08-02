# Due APP _EXE4-2_Remix

Add role-based access control to this existing app. All users share the same overdue sales invoice dashboard, and data visibility is entirely governed by each user's N3 credential — no app-level role management is required because N3 enforces which invoices, companies, and entities each user is permitted to see. Users can only view overdue invoice data for the companies or entities their N3 account has access to, with multi-company visibility enforced by N3 rather than any app-side logic. The dashboard is strictly read-only, meaning no invoice records are created, edited, or posted back — all overdue invoice counts and total overdue amounts flow from N3 into the dashboard only. Pull all displayed data live from N3 on every page load so that invoice status, overdue amounts, and invoice counts always reflect N3's current state with no cached or manually-entered values. Provide a date range filter that allows users to narrow the overdue invoice view, but ensure every filter interaction triggers a fresh N3 data pull so that N3 continues to enforce what data is returned and users can never surface records outside their permission scope. Display a last-refreshed timestamp on the dashboard so users can confirm exactly when the overdue invoice data was last fetched from N3. Do not change any existing app functionality — add role enforcement on top of what is already built.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://termdue.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/17f61cb2-c373-4195-b5e2-094233d16762).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
