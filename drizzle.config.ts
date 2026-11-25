import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/core/task/schema.ts",
  out: "./drizzle",
});
