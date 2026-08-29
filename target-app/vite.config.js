import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Served through Runloop tunnels (https://5173-<key>.tunnel.runloop.ai)
    allowedHosts: [".tunnel.runloop.ai"],
    hmr: { clientPort: 443 },
  },
});
