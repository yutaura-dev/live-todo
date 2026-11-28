import { defineConfig } from "drizzle-kit";

// 作り直しのアプリの DB。今のアプリの drizzle.config.ts とはマイグレーションを分ける
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema.ts",
  out: "./drizzle-store",
});
