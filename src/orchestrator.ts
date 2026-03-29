import type pino from "pino";
import type { AppConfig } from "./config.js";
import { StateStore } from "./db.js";
import { GitHubClient } from "./github.js";
import { PlannerAdapter } from "./planner.js";
import {
  buildCodexPrompt,
  formatBlockingComment,
  formatCompletionComment,
  formatPlanComment,
  formatStatusComment
} from "./prompts.js";
import type {
  OrchestratorCommentContext,
  OrchestratorIssueContext,
  PlanSpec,
  ReviewResult,
  RunRecord,
  RunTrigger
} from "./types.js";
import { createRunId } from "./utils.js";
import { WorkspaceManager } from "./workspace.js";
import { CodexRunner } from "./codex.js";

export class Orchestrator {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: StateStore,
    private readonly github: GitHubClient,
    private readonly planner: PlannerAdapter,
    private readonly codex: CodexRunner,
    private readonly workspace: WorkspaceManager,
    private readonly logger: pino.Logger
  ) {}

  shouldProcessIssue(context: OrchestratorIssueContext): boolean {
    return context.issue.labels.some((label) => label.name === context.repositoryConfig.autoLabel);
  }

  async handleIssueOpened(context: OrchestratorIssueContext, trigger: RunTrigger = "issue_opened"): Promise<void> {
    if (!this.github.isRepoAllowed(context.repoOwner, context.repoName)) {
      this.logger.info(
        { repo: `${context.repoOwner}/${context.repoName}`, issue: context.issue.number },
        "Ignoring repo outside allowlist"
      );
      return;
    }

    if (!this.shouldProcessIssue(context)) {
      this.logger.info(
        { repo: `${context.repoOwner}/${context.repoName}`, issue: context.issue.number },
        "Ignoring issue without repo auto label"
      );
      return;
    }

    await this.runIssue(context, trigger);
  }

  async handleCommentCommand(context: OrchestratorCommentContext, command: "status" | "retry" | "replan" | "abort") {
    const { repoOwner, repoName, issue } = context;
    const issueRecord = this.store.getIssue(repoOwner, repoName, issue.number);

    if (command === "status") {
      const current = this.store.getActiveRun(repoOwner, repoName, issue.number);
      const recent = this.store.listRuns(repoOwner, repoName, issue.number, 5);
      await this.github.commentOnIssue(
        repoOwner,
        repoName,
        issue.number,
        formatStatusComment(issueRecord?.status ?? "unknown", current, recent)
      );
      return;
    }

    if (!this.canControlRuns(context)) {
      await this.github.commentOnIssue(
        repoOwner,
        repoName,
        issue.number,
        `User @${context.comment.userLogin} is not allowed to control automation for this repository.`
      );
      return;
    }

    if (command === "abort") {
      const active = this.store.getActiveRun(repoOwner, repoName, issue.number);
      if (!active) {
        await this.github.commentOnIssue(repoOwner, repoName, issue.number, "No active run to abort.");
        return;
      }

      this.store.requestAbort(active.runId);
      this.abortControllers.get(active.runId)?.abort();
      await this.github.commentOnIssue(
        repoOwner,
        repoName,
        issue.number,
        `Abort requested for run ${active.runId}.`
      );
      return;
    }

    const active = this.store.getActiveRun(repoOwner, repoName, issue.number);
    if (active) {
      await this.github.commentOnIssue(
        repoOwner,
        repoName,
        issue.number,
        `Run ${active.runId} is already active in phase ${active.phase}. Use /status or /abort first.`
      );
      return;
    }

    await this.runIssue(context, command);
  }

  async getIssueStatus(repoOwner: string, repoName: string, issueNumber: number) {
    return {
      issue: this.store.getIssue(repoOwner, repoName, issueNumber),
      runs: this.store.listRuns(repoOwner, repoName, issueNumber, 10)
    };
  }

  private async safeCommentOnIssue(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    try {
      await this.github.commentOnIssue(repoOwner, repoName, issueNumber, body);
    } catch (error) {
      this.logger.error({ repo: `${repoOwner}/${repoName}`, issue: issueNumber, err: error }, "Issue comment failed");
    }
  }

  private canControlRuns(context: OrchestratorCommentContext): boolean {
    const allowed = context.repositoryConfig.allowedCommenters;
    return allowed.length === 0 || allowed.includes(context.comment.userLogin);
  }

  private async runIssue(context: OrchestratorIssueContext, trigger: RunTrigger): Promise<void> {
    const existing = this.store.getActiveRun(context.repoOwner, context.repoName, context.issue.number);
    if (existing) {
      this.logger.info(
        { runId: existing.runId, repo: `${context.repoOwner}/${context.repoName}`, issue: context.issue.number },
        "Skipping new run because another run is active"
      );
      return;
    }

    this.store.upsertIssue({
      repoOwner: context.repoOwner,
      repoName: context.repoName,
      issueNumber: context.issue.number,
      issueId: context.issue.id,
      title: context.issue.title,
      body: context.issue.body,
      status: "received"
    });

    const run = this.store.createRun({
      runId: createRunId(),
      repoOwner: context.repoOwner,
      repoName: context.repoName,
      issueNumber: context.issue.number,
      trigger
    });

    this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
      activeRunId: run.runId,
      lastError: null
    });

    const controller = new AbortController();
    this.abortControllers.set(run.runId, controller);

    try {
      await this.validateRepository(context);
      await this.executeRun(context, run, controller);
    } finally {
      this.abortControllers.delete(run.runId);
    }
  }

  private async executeRun(
    context: OrchestratorIssueContext,
    run: RunRecord,
    controller: AbortController
  ): Promise<void> {
    try {
      this.transitionIssue(context, run.runId, "planning", "planning");
      this.ensureNotAborted(run.runId);

      const plan = await this.planner.generatePlan(context.issue, controller.signal);
      this.store.storeArtifact(run.runId, "plan.json", JSON.stringify(plan, null, 2));

      if (plan.blockingQuestions.length > 0) {
        this.store.completeRun(run.runId, "blocked", "Planning requires clarification.");
        this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
          status: "blocked",
          activeRunId: null
        });
        await this.safeCommentOnIssue(
          context.repoOwner,
          context.repoName,
          context.issue.number,
          formatBlockingComment(plan.blockingQuestions)
        );
        return;
      }

      this.store.setRunPhase(run.runId, "planned", plan.summary);
      this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
        status: "planned"
      });
      await this.safeCommentOnIssue(
        context.repoOwner,
        context.repoName,
        context.issue.number,
        formatPlanComment(plan)
      );

      const branchName = this.workspace.createBranchName(context.issue.number, context.issue.title);
      const worktreePath = await this.workspace.ensureWorktree(
        context.repositoryConfig.localPath,
        context.repoOwner,
        context.repoName,
        branchName,
        context.issue.number,
        context.repositoryConfig.baseBranch
      );

      this.transitionIssue(context, run.runId, "executing", "executing", branchName, worktreePath);

      let requiredFixes: string[] = [];
      let execution = await this.codex.execute(
        worktreePath,
        buildCodexPrompt(context.issue, plan),
        context.repositoryConfig.testCommands,
        controller.signal
      );
      this.store.storeArtifact(run.runId, "execution-1.json", JSON.stringify(execution, null, 2));

      let review: ReviewResult | null = null;
      for (let attempt = 0; attempt < this.config.MAX_REVIEW_LOOPS; attempt += 1) {
        this.ensureNotAborted(run.runId);
        this.store.setRunPhase(run.runId, "reviewing", `Review attempt ${attempt + 1}`);
        this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
          status: "reviewing"
        });

        review = await this.planner.reviewExecution(context.issue, plan, execution, controller.signal);
        this.store.storeArtifact(run.runId, `review-${attempt + 1}.json`, JSON.stringify(review, null, 2));

        if (review.approved) {
          break;
        }

        requiredFixes = review.requiredFixes;
        if (attempt === this.config.MAX_REVIEW_LOOPS - 1) {
          break;
        }

        this.transitionIssue(context, run.runId, "executing", "executing", branchName, worktreePath);
        execution = await this.codex.execute(
          worktreePath,
          buildCodexPrompt(context.issue, plan, requiredFixes),
          context.repositoryConfig.testCommands,
          controller.signal
        );
        this.store.storeArtifact(run.runId, `execution-${attempt + 2}.json`, JSON.stringify(execution, null, 2));
      }

      if (!review?.approved) {
        const summary = review?.reviewSummary ?? "Review rejected execution.";
        this.store.completeRun(run.runId, "failed", summary);
        this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
          status: "failed",
          lastError: summary,
          activeRunId: null
        });
        await this.safeCommentOnIssue(
          context.repoOwner,
          context.repoName,
          context.issue.number,
          `Review rejected the execution.\n\n${summary}\n\nRequired fixes:\n${requiredFixes.map((item) => `- ${item}`).join("\n") || "- none"}`
        );
        return;
      }

      const committed = this.config.DRY_RUN
        ? false
        : await this.workspace.commitChanges(worktreePath, context.issue.number);
      this.store.storeArtifact(run.runId, "commit.json", JSON.stringify({ committed }, null, 2));

      try {
        if (!this.config.DRY_RUN) {
          await this.workspace.pushBranch(worktreePath, branchName);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.completeRun(run.runId, "failed", message);
        this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
          status: "push_failed",
          lastError: message,
          activeRunId: null
        });
        await this.safeCommentOnIssue(
          context.repoOwner,
          context.repoName,
          context.issue.number,
          `Push failed.\n\n${message}`
        );
        return;
      }

      const pullRequest = await this.github.createOrReusePullRequest(
        context.repoOwner,
        context.repoName,
        branchName,
        context.repositoryConfig.baseBranch,
        review.prTitle,
        review.prBody
      );

      this.store.storeArtifact(run.runId, "pull-request.json", JSON.stringify(pullRequest, null, 2));
      this.store.completeRun(run.runId, "completed", review.reviewSummary);
      this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
        status: "completed",
        prNumber: pullRequest.number,
        branchName,
        worktreePath,
        activeRunId: null
      });
      await this.safeCommentOnIssue(
        context.repoOwner,
        context.repoName,
        context.issue.number,
        formatCompletionComment(review, pullRequest.htmlUrl)
      );
      await this.github.addLabels(context.repoOwner, context.repoName, context.issue.number, [
        "done-by-bot"
      ]);
    } catch (error) {
      const aborted = this.store.isAbortRequested(run.runId) || controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      this.store.completeRun(run.runId, aborted ? "aborted" : "failed", message);
      this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
        status: aborted ? "aborted" : "failed",
        lastError: message,
        activeRunId: null
      });
      this.logger.error(
        { repo: `${context.repoOwner}/${context.repoName}`, issue: context.issue.number, runId: run.runId, err: error },
        "Orchestration failed"
      );
      await this.safeCommentOnIssue(
        context.repoOwner,
        context.repoName,
        context.issue.number,
        aborted ? `Run ${run.runId} aborted.` : `Workflow failed during automation.\n\nError: ${message}`
      );
    }
  }

  private transitionIssue(
    context: OrchestratorIssueContext,
    runId: string,
    phase: "planning" | "executing",
    status: "planning" | "executing",
    branchName?: string,
    worktreePath?: string
  ) {
    this.store.setRunPhase(runId, phase);
    this.store.updateIssueState(context.repoOwner, context.repoName, context.issue.number, {
      status,
      branchName,
      worktreePath
    });
  }

  private async validateRepository(context: OrchestratorIssueContext) {
    this.workspace.ensureRepositoryExists(context.repositoryConfig.localPath);
    await this.workspace.ensureBaseBranch(
      context.repositoryConfig.localPath,
      context.repositoryConfig.baseBranch
    );
  }

  private ensureNotAborted(runId: string) {
    if (this.store.isAbortRequested(runId)) {
      throw new Error("Run aborted by user.");
    }
  }
}
