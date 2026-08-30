import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const hubTarget =
    loadEnv(mode, ".", "").ENSEMBLE_HUB_URL || "http://localhost:8080";
  const proxy = {
    "/rooms": {
      target: hubTarget,
      changeOrigin: true,
    },
    "/runner": {
      target: hubTarget,
      changeOrigin: true,
    },
    "/healthz": {
      target: hubTarget,
      changeOrigin: true,
    },
    "/bundle": {
      target: hubTarget,
      changeOrigin: true,
    },
    "/ws": {
      target: hubTarget,
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    plugins: [react()],
    server: {
      proxy,
    },
    preview: {
      proxy,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
