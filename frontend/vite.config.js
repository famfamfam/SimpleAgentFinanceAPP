import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shared =
  /^\/(db|chat-db|sync|model|icons|release|i18n|en|en-screens|en-forms)\.js$/;
const apiTarget = process.env.VITE_API_TARGET || "http://127.0.0.1:18080";
const proxy = {
  target: apiTarget,
  changeOrigin: false,
  // Keep the browser's same-origin Host/Origin pair for the Go CSRF check.
  configure(server) {
    server.on("proxyReq", (outgoing, request) =>
      outgoing.setHeader("Host", request.headers.host),
    );
  },
};
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "canonical-modules",
      enforce: "pre",
      resolveId(id) {
        if (shared.test(id)) return { id, external: true };
      },
    },
    react(),
  ],
  server: {
    // Shared modules are proxied, not files Vite can pre-transform locally.
    preTransformRequests: false,
    proxy: {
      "^/(api|mcp)(/|$)": proxy,
      "^/(db|chat-db|sync|model|icons|release|i18n|en|en-screens|en-forms)\\.js$":
        proxy,
      "^/(icon.*|manifest\\.webmanifest)$": proxy,
    },
  },
  build: {
    outDir: "../backend/react-web/dist",
    emptyOutDir: true,
    rollupOptions: { external: (id) => shared.test(id) },
  },
});
