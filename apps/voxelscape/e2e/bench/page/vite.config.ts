import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The report is a page of numbers that have already happened: nothing on it
// reacts, so it is generated once and written as a file. Without `hydratable`
// the compiler leaves out the keys and comment markers only a browser picking
// the page back up would read.
export default defineConfig({
  plugins: [solid({ ssr: true, solid: { hydratable: false } })],
});
