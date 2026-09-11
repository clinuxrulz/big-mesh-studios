// Where the world lives under the address bar.
//
// GitHub Pages is a static file host with no server-side routing at all: an
// address a client-side router owns (`/demos/gasa4`, say) is not a file it
// holds, and the one workaround that does not involve GitHub Pages quietly
// answering a real address with a 404 is to never send the route to the
// server in the first place. Routing on the URL's hash does that — the
// browser never sends the fragment after `#` in the request, so every
// address below is `/big-mesh-studios/voxelscape/#/demos/gasa4`, one single
// real page (`index.html`) as far as GitHub Pages is concerned, with the
// hash read back out by the router once that page has loaded.
//
// The site's own folder (`import.meta.env.BASE_URL`, set from `vite.config.ts`)
// still matters for every asset this application fetches — see its `base`
// comment — but not for routing: the hash carries no site prefix, so the
// router is given none to match against.
import { createRouter, defineRoutes, hashHistory } from "@solidjs/router";
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

export const Router = createRouter({ routes, history: hashHistory() });
