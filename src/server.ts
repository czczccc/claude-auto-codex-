import express from "express";
import type pino from "pino";
import type { AppConfig } from "./config.js";
import { StateStore } from "./db.js";
import { GitHubClient } from "./github.js";
import type { Orchestrator } from "./orchestrator.js";
import { RepositoryRegistry } from "./repository-config.js";
import { parseCommentCommand, verifyGitHubSignature } from "./utils.js";

export function createServer(
  config: AppConfig,
  store: StateStore,
  github: GitHubClient,
  repositoryRegistry: RepositoryRegistry,
  orchestrator: Orchestrator,
  logger: pino.Logger
) {
  const app = express();

  app.use(
    express.raw({
      type: "application/json"
    })
  );

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/runs/:owner/:repo/:issueNumber", (request, response) => {
    const issueNumber = Number(request.params.issueNumber);
    const status = orchestrator.getIssueStatus(request.params.owner, request.params.repo, issueNumber);
    response.json(status);
  });

  app.post("/webhooks/github", async (request, response) => {
    const deliveryId = request.header("x-github-delivery");
    const signature = request.header("x-hub-signature-256");
    const eventName = request.header("x-github-event");
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);

    if (!verifyGitHubSignature(rawBody, signature, config.GITHUB_APP_WEBHOOK_SECRET)) {
      response.status(401).json({ ok: false, error: "invalid signature" });
      return;
    }

    if (!deliveryId) {
      response.status(400).json({ ok: false, error: "missing delivery id" });
      return;
    }

    if (store.hasDelivery(deliveryId)) {
      response.status(202).json({ ok: true, duplicate: true });
      return;
    }
    store.recordDelivery(deliveryId);

    const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const repository = payload.repository as
      | { name?: unknown; default_branch?: unknown; owner?: { login?: unknown } }
      | undefined;
    const repoOwner = String(repository?.owner?.login ?? "");
    const repoName = String(repository?.name ?? "");
    const repoConfig = repositoryRegistry.get(repoOwner, repoName);

    if (!repoOwner || !repoName || !repoConfig) {
      response.status(202).json({ ok: true, ignored: true, reason: "repository not registered" });
      return;
    }

    response.status(202).json({ ok: true });

    try {
      if (eventName === "issues") {
        const action = String(payload.action ?? "");
        if (action !== "opened" && action !== "labeled") {
          return;
        }

        await orchestrator.handleIssueOpened(
          {
            issue: GitHubClient.normalizeIssue(payload),
            repoOwner,
            repoName,
            baseBranch: String(repository?.default_branch ?? repoConfig.baseBranch),
            repositoryConfig: repoConfig
          },
          action === "labeled" ? "issue_labeled" : "issue_opened"
        );
        return;
      }

      if (eventName === "issue_comment") {
        const action = String(payload.action ?? "");
        if (action !== "created") {
          return;
        }

        const comment = GitHubClient.normalizeComment(payload);
        const command = parseCommentCommand(comment.body);
        if (!command) {
          return;
        }

        await orchestrator.handleCommentCommand(
          {
            issue: GitHubClient.normalizeIssue(payload),
            comment,
            repoOwner,
            repoName,
            baseBranch: String(repository?.default_branch ?? repoConfig.baseBranch),
            repositoryConfig: repoConfig
          },
          command.command
        );
      }
    } catch (error) {
      logger.error({ err: error, eventName, repo: `${repoOwner}/${repoName}` }, "Webhook handling failed");
    }
  });

  return app;
}
