import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "../src/prompts.js";
import { loadConfig } from "../src/config.js";
import { RepositoryRegistry } from "../src/repository-config.js";
import { parseCommentCommand, verifyGitHubSignature } from "../src/utils.js";

describe("config", () => {
  it("parses defaults", () => {
    const config = loadConfig({
      GITHUB_APP_WEBHOOK_SECRET: "secret",
      GITHUB_TOKEN: "token",
      PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
      PLANNER_API_KEY: "key",
      PLANNER_MODEL: "deepseek-chat"
    });

    expect(config.PORT).toBe(3000);
    expect(config.GITHUB_AUTO_LABEL).toBe("auto-dev");
    expect(config.DRY_RUN).toBe(true);
  });
});

describe("signature verification", () => {
  it("matches GitHub sha256 signatures", async () => {
    const secret = "top-secret";
    const raw = Buffer.from('{"hello":"world"}');
    const crypto = await import("node:crypto");
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("hex");

    expect(verifyGitHubSignature(raw, `sha256=${digest}`, secret)).toBe(true);
    expect(verifyGitHubSignature(raw, "sha256=bad", secret)).toBe(false);
  });
});

describe("prompt building", () => {
  it("includes task and acceptance details for Codex", () => {
    const prompt = buildCodexPrompt(
      {
        id: 1,
        number: 12,
        title: "Add health endpoint",
        body: "Need a /health endpoint.",
        htmlUrl: "https://example.com/issues/12",
        labels: [{ name: "auto-dev" }],
        userLogin: "alice"
      },
      {
        summary: "Add endpoint",
        assumptions: [],
        plan: [],
        tasks: [
          {
            id: "task-1",
            title: "Add route",
            description: "Implement /health route.",
            paths: ["src/server.ts"],
            doneDefinition: "Route responds 200.",
            risks: []
          }
        ],
        acceptanceCriteria: ["GET /health returns ok"],
        testPlan: ["curl the endpoint"],
        blockingQuestions: [],
        codexInstruction: "Keep it minimal."
      }
    );

    expect(prompt).toContain("Add health endpoint");
    expect(prompt).toContain("GET /health returns ok");
    expect(prompt).toContain("src/server.ts");
  });
});

describe("comment commands", () => {
  it("parses supported automation commands", () => {
    expect(parseCommentCommand("/status")).toEqual({ command: "status", raw: "/status" });
    expect(parseCommentCommand("/retry because flaky")).toEqual({
      command: "retry",
      raw: "/retry because flaky"
    });
    expect(parseCommentCommand("hello")).toBeNull();
  });
});

describe("repository registry", () => {
  it("loads structured repository config with defaults", () => {
    const registry = new RepositoryRegistry(
      loadConfig({
        GITHUB_APP_WEBHOOK_SECRET: "secret",
        GITHUB_TOKEN: "token",
        PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
        PLANNER_API_KEY: "key",
        PLANNER_MODEL: "deepseek-chat",
        REPO_CONFIG_PATH: "./repositories.example.json",
        REPO_ROOT: "/tmp/repos"
      })
    );

    const repo = registry.get("your-org", "your-repo");
    expect(repo?.baseBranch).toBe("main");
    expect(repo?.autoLabel).toBe("auto-dev");
    expect(repo?.localPath).toContain("/tmp/repos/your-org/your-repo");
  });
});
