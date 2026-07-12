import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

export default defineConfig(({ command }) => ({
  plugins: [
    vinext({
      cache: { cdn: cdnAdapter() },
    }),
    ...(command === "build"
      ? [cloudflare({
          viteEnvironment: {
            name: "rsc",
            childEnvironments: ["ssr"],
          },
        })]
      : []),
  ],
}));
