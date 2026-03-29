import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "../src/prompts.js";
import { loadConfig } from "../src/config.js";
import { StateStore } from "../src/db.js";
import { extractJsonPayload } from "../src/planner.js";
import { GitHubPoller } from "../src/poller.js";
import { RepositoryRegistry } from "../src/repository-config.js";
import { parseCommentCommand, verifyGitHubSignature } from "../src/utils.js";
import type { GitHubIssueSnapshot } from "../src/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("config", () => {
  it("parses defaults", () => {
    const config = loadConfig({
      GITHUB_TOKEN: "token",
      PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
      PLANNER_API_KEY: "key",
      PLANNER_MODEL: "deepseek-chat",
      GITHUB_APP_WEBHOOK_SECRET: "secret"
    });

    expect(config.PORT).toBe(3000);
    expect(config.GITHUB_AUTO_LABEL).toBe("auto-dev");
    expect(config.DRY_RUN).toBe(true);
  });

  it("allows poll mode without a webhook secret", () => {
    const config = loadConfig({
      INGEST_MODE: "poll",
      GITHUB_TOKEN: "token",
      PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
      PLANNER_API_KEY: "key",
      PLANNER_MODEL: "deepseek-chat"
    });

    expect(config.INGEST_MODE).toBe("poll");
    expect(config.GITHUB_APP_WEBHOOK_SECRET).toBeUndefined();
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

describe("planner json extraction", () => {
  it("strips fenced json responses before parsing", () => {
    const json = extractJsonPayload('```json\n{"ok":true}\n```');
    expect(JSON.parse(json)).toEqual({ ok: true });
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

describe("github poller", () => {
  function makeIssue(overrides: Partial<GitHubIssueSnapshot> = {}): GitHubIssueSnapshot {
    return {
      id: 1,
      number: 12,
      title: "Issue title",
      body: "Issue body",
      htmlUrl: "https://example.com/issues/12",
      labels: [],
      userLogin: "alice",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
      ...overrides
    };
  }

  function makeStore(): StateStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auto-codex-"));
    return new StateStore(path.join(dir, "state.sqlite"));
  }

  it("triggers issue_opened once for a newly labeled issue", async () => {
    const store = makeStore();
    const orchestratorCalls: Array<{ trigger: string; issueNumber: number }> = [];
    const github = {
      isRepoAllowed: () => true,
      listOpenIssuesSince: async () => [
        makeIssue({
          labels: [{ name: "auto-dev" }],
          updatedAt: "2026-03-29T00:00:05.000Z"
        })
      ],
      listIssueCommentsSince: async () => [],
      getIssue: async () => makeIssue()
    };
    const poller = new GitHubPoller(
      loadConfig({
        INGEST_MODE: "poll",
        GITHUB_TOKEN: "token",
        PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
        PLANNER_API_KEY: "key",
        PLANNER_MODEL: "deepseek-chat"
      }),
      store,
      github as any,
      {
        list: () => [
          {
            owner: "your-org",
            repo: "your-repo",
            localPath: "/tmp/repos/your-org/your-repo",
            baseBranch: "main",
            autoLabel: "auto-dev",
            allowedCommenters: [],
            testCommands: []
          }
        ]
      } as any,
      {
        handleIssueOpened: async (context: { issue: { number: number } }, trigger: string) => {
          orchestratorCalls.push({ trigger, issueNumber: context.issue.number });
        },
        handleCommentCommand: async () => {}
      } as any,
      { info: () => {}, error: () => {} } as any
    );

    await poller.runOnce();
    await poller.runOnce();

    expect(orchestratorCalls).toEqual([{ trigger: "issue_opened", issueNumber: 12 }]);
  });

  it("triggers issue_labeled when the auto label appears later", async () => {
    const store = makeStore();
    const seenLabelStates = [false, true];
    const orchestratorCalls: string[] = [];
    const github = {
      isRepoAllowed: () => true,
      listOpenIssuesSince: async () => [
        makeIssue({
          labels: seenLabelStates.shift() ? [{ name: "auto-dev" }] : [],
          updatedAt: "2026-03-29T00:00:10.000Z"
        })
      ],
      listIssueCommentsSince: async () => [],
      getIssue: async () => makeIssue()
    };
    const poller = new GitHubPoller(
      loadConfig({
        INGEST_MODE: "poll",
        GITHUB_TOKEN: "token",
        PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
        PLANNER_API_KEY: "key",
        PLANNER_MODEL: "deepseek-chat"
      }),
      store,
      github as any,
      {
        list: () => [
          {
            owner: "your-org",
            repo: "your-repo",
            localPath: "/tmp/repos/your-org/your-repo",
            baseBranch: "main",
            autoLabel: "auto-dev",
            allowedCommenters: [],
            testCommands: []
          }
        ]
      } as any,
      {
        handleIssueOpened: async (_context: unknown, trigger: string) => {
          orchestratorCalls.push(trigger);
        },
        handleCommentCommand: async () => {}
      } as any,
      { info: () => {}, error: () => {} } as any
    );

    await poller.runOnce();
    await poller.runOnce();

    expect(orchestratorCalls).toEqual(["issue_labeled"]);
  });

  it("dedupes repeated comment commands by comment id", async () => {
    const store = makeStore();
    const commentCalls: string[] = [];
    const github = {
      isRepoAllowed: () => true,
      listOpenIssuesSince: async () => [],
      listIssueCommentsSince: async () => [
        {
          id: 99,
          issueNumber: 12,
          body: "/status",
          userLogin: "alice",
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:00:00.000Z"
        }
      ],
      getIssue: async () => makeIssue({ number: 12 })
    };
    const poller = new GitHubPoller(
      loadConfig({
        INGEST_MODE: "poll",
        GITHUB_TOKEN: "token",
        PLANNER_API_BASE_URL: "https://api.deepseek.com/v1",
        PLANNER_API_KEY: "key",
        PLANNER_MODEL: "deepseek-chat"
      }),
      store,
      github as any,
      {
        list: () => [
          {
            owner: "your-org",
            repo: "your-repo",
            localPath: "/tmp/repos/your-org/your-repo",
            baseBranch: "main",
            autoLabel: "auto-dev",
            allowedCommenters: [],
            testCommands: []
          }
        ]
      } as any,
      {
        handleIssueOpened: async () => {},
        handleCommentCommand: async (_context: unknown, command: string) => {
          commentCalls.push(command);
        }
      } as any,
      { info: () => {}, error: () => {} } as any
    );

    await poller.runOnce();
    await poller.runOnce();

    expect(commentCalls).toEqual(["status"]);
  });
});
