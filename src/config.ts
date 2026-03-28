import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_AUTO_LABEL: z.string().default("auto-dev"),
  GITHUB_DEFAULT_BASE_BRANCH: z.string().default("main"),
  REPO_ROOT: z.string().default("./repos"),
  REPO_CONFIG_PATH: z.string().default("./repositories.json"),
  REPO_ALLOWLIST: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : []
    ),
  WORKTREE_ROOT: z.string().default("./data/worktrees"),
  DB_PATH: z.string().default("./data/orchestrator.sqlite"),
  PLANNER_API_BASE_URL: z.string().url(),
  PLANNER_API_KEY: z.string().min(1),
  PLANNER_MODEL: z.string().min(1),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_ARGS: z.string().default("exec --full-auto"),
  MAX_REVIEW_LOOPS: z.coerce.number().int().positive().default(2)
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
