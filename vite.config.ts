import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    watch: {
      // Bot writes config/keys here — never restart Vite for these
      ignored: [
        "**/.env",
        "**/.env.*",
        "**/server/runtime-config.json",
        "**/.browser-profile/**",
        "**/.browser-profile-w*/**",
        "**/node_modules/**",
      ],
    },
  },
});
