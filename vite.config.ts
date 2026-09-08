import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3000,
    // 监听 0.0.0.0（IPv4）。本机代理软件的 TUN 模式会拦截 IPv6 回环连接，
    // 而 vite 默认只绑定 [::1]，导致 localhost 无法访问
    host: true
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"]
  },
  ssr: {
    noExternal: ["pdfjs-dist"]
  },
  plugins: [
    tsconfigPaths(),
    tanstackStart({
      srcDirectory: "src",
      router: {
        routesDirectory: "routes"
      }
    }),
    viteReact()
  ]
});
