import type pino from "pino";
import type { AppConfig } from "./config.js";
import { StateStore } from "./db.js";
import { GitHubClient } from "./github.js";
import { Orchestrator } from "./orchestrator.js";
import { RepositoryRegistry } from "./repository-config.js";
import type { GitHubIssueSnapshot, ResolvedRepositoryConfig, RunTrigger } from "./types.js";
import { parseCommentCommand } from "./utils.js";

function subtractSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(new Date(isoTimestamp).getTime() - seconds * 1000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

export class GitHubPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly github: GitHubClient,
    private readonly repositoryRegistry: RepositoryRegistry,
    private readonly orchestrator: Orchestrator,
    private readonly logger: pino.Logger
  ) {}

  start(): void {
    this.logger.info(
      {
        intervalMs: this.config.POLL_INTERVAL_MS,
        lookbackSeconds: this.config.POLL_COMMENT_LOOKBACK_SECONDS
      },
      "GitHub poller started"
    );
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    for (const repositoryConfig of this.repositoryRegistry.list()) {
      if (!this.github.isRepoAllowed(repositoryConfig.owner, repositoryConfig.repo)) {
        continue;
      }

      await this.processRepository(repositoryConfig);
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error({ err: error }, "GitHub poll loop failed");
      }

      await new Promise<void>((resolve) => {
        this.timer = setTimeout(() => resolve(), this.config.POLL_INTERVAL_MS);
      });
    }
  }

  private async processRepository(repositoryConfig: ResolvedRepositoryConfig): Promise<void> {
    const { owner, repo } = repositoryConfig;
    const pollState = this.store.getRepoPollState(owner, repo);
    const fallbackCursor = subtractSeconds(nowIso(), this.config.POLL_COMMENT_LOOKBACK_SECONDS);
    const issueSince = subtractSeconds(
      pollState.issueCursor ?? fallbackCursor,
      this.config.POLL_COMMENT_LOOKBACK_SECONDS
    );
    const commentSince = subtractSeconds(
      pollState.commentCursor ?? fallbackCursor,
      this.config.POLL_COMMENT_LOOKBACK_SECONDS
    );

    const issues = await this.github.listOpenIssuesSince(
      owner,
      repo,
      issueSince,
      this.config.POLL_REPO_BATCH_SIZE
    );

    let maxIssueCursor = pollState.issueCursor;
    for (const issue of issues) {
      await this.processIssue(repositoryConfig, issue);
      if (!maxIssueCursor || issue.updatedAt > maxIssueCursor) {
        maxIssueCursor = issue.updatedAt;
      }
    }

    const comments = await this.github.listIssueCommentsSince(
      owner,
      repo,
      commentSince,
      this.config.POLL_REPO_BATCH_SIZE
    );

    let maxCommentCursor = pollState.commentCursor;
    for (const comment of comments) {
      await this.processComment(repositoryConfig, comment.issueNumber, comment.id, comment.body, comment.userLogin);
      if (!maxCommentCursor || comment.updatedAt > maxCommentCursor) {
        maxCommentCursor = comment.updatedAt;
      }
    }

    this.store.setRepoPollState(owner, repo, {
      issueCursor: maxIssueCursor ?? pollState.issueCursor ?? nowIso(),
      commentCursor: maxCommentCursor ?? pollState.commentCursor ?? nowIso()
    });
  }

  private async processIssue(
    repositoryConfig: ResolvedRepositoryConfig,
    issue: GitHubIssueSnapshot
  ): Promise<void> {
    const hasAutoLabel = issue.labels.some((label) => label.name === repositoryConfig.autoLabel);
    const observation = this.store.getIssueObservation(
      repositoryConfig.owner,
      repositoryConfig.repo,
      issue.number
    );
    const issueRecord = this.store.getIssue(repositoryConfig.owner, repositoryConfig.repo, issue.number);

    let trigger: RunTrigger | null = null;
    if (hasAutoLabel && !observation) {
      trigger = issueRecord ? "issue_labeled" : "issue_opened";
    } else if (hasAutoLabel && !observation.hasAutoLabel) {
      trigger = "issue_labeled";
    }

    this.store.setIssueObservation(
      repositoryConfig.owner,
      repositoryConfig.repo,
      issue.number,
      hasAutoLabel
    );

    if (!trigger) {
      return;
    }

    await this.orchestrator.handleIssueOpened(
      {
        issue,
        repoOwner: repositoryConfig.owner,
        repoName: repositoryConfig.repo,
        baseBranch: repositoryConfig.baseBranch,
        repositoryConfig
      },
      trigger
    );
  }

  private async processComment(
    repositoryConfig: ResolvedRepositoryConfig,
    issueNumber: number,
    commentId: number,
    body: string,
    userLogin: string
  ): Promise<void> {
    if (this.store.hasProcessedIssueComment(commentId)) {
      return;
    }

    const command = parseCommentCommand(body);
    if (!command) {
      this.store.recordProcessedIssueComment(
        commentId,
        repositoryConfig.owner,
        repositoryConfig.repo,
        issueNumber
      );
      return;
    }

    const issue = await this.github.getIssue(repositoryConfig.owner, repositoryConfig.repo, issueNumber);

    await this.orchestrator.handleCommentCommand(
      {
        issue,
        comment: {
          body,
          userLogin
        },
        repoOwner: repositoryConfig.owner,
        repoName: repositoryConfig.repo,
        baseBranch: repositoryConfig.baseBranch,
        repositoryConfig
      },
      command.command
    );

    this.store.recordProcessedIssueComment(
      commentId,
      repositoryConfig.owner,
      repositoryConfig.repo,
      issueNumber
    );
  }
}
