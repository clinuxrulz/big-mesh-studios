// Where the world lives under the address bar, and where the application
// itself lives under the site.
//
// Addresses are real paths, not a query string, so an asset cannot be found
// relative to the page that asked for it — see the `base` comment in
// `vite.config.ts`. GitHub Pages has no idea a deep path is a page rather than
// a missing file, so the deploy workflow copies `index.html` to `404.html`,
// and the router then reads the address it was asked for.
import { createRouter, defineRoutes } from "@solidjs/router";
import App from "./App";

export const routes = defineRoutes([
  { path: "/", component: App },
  // A handle always carries a dot and a DID always starts with "did:" (see
  // `readPlaceRequest` in `commands.ts`), so "demos" can never be mistaken for
  // one — a built-in demo lives at a reserved path, ahead of the catch-all
  // below, rather than sharing its address space with published places.
  { path: "/demos/:id", component: App },
  { path: "/:handle/:worldName", component: App },
]);

export const Router = createRouter({ routes, base: import.meta.env.BASE_URL });
