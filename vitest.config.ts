import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 既定の探索だと .direnv/ に展開された nixpkgs のソース内のテストまで拾うため、src に限定する。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
