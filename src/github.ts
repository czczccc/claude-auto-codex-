import { Octokit } from "@octokit/rest";
import type { AppConfig } from "./config.js";
import type {
  GitHubCommentPayload,
  GitHubIssueCommentEvent,
  GitHubIssuePayload,
  GitHubIssueSnapshot
} from "./types.js";

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(private readonly config: AppConfig) {
    this.octokit = new Octokit({ auth: config.GITHUB_TOKEN });
  }

  static normalizeIssue(payload: Record<string, unknown>): GitHubIssuePayload {
    return GitHubClient.normalizeIssueRecord(payload.issue as Record<string, unknown>);
  }

  static normalizeComment(payload: Record<string, unknown>): GitHubCommentPayload {
    const comment = payload.comment as Record<string, unknown>;
    return {
      body: String(comment.body ?? ""),
      userLogin: String((comment.user as { login?: unknown } | undefined)?.login ?? "")
    };
  }

  static normalizeIssueRecord(issue: Record<string, unknown>): GitHubIssueSnapshot {
    const labels = Array.isArray(issue.labels) ? issue.labels : [];

    return {
      id: Number(issue.id),
      number: Number(issue.number),
      title: String(issue.title ?? ""),
      body: String(issue.body ?? ""),
      htmlUrl: String(issue.html_url ?? ""),
      labels: labels.map((label) => ({ name: String((label as { name?: unknown }).name ?? "") })),
      userLogin: String((issue.user as { login?: unknown } | undefined)?.login ?? ""),
      updatedAt: String(issue.updated_at ?? ""),
      createdAt: String(issue.created_at ?? "")
    };
  }

  isRepoAllowed(repoOwner: string, repoName: string): boolean {
    if (this.config.REPO_ALLOWLIST.length === 0) {
      return true;
    }

    return this.config.REPO_ALLOWLIST.includes(`${repoOwner}/${repoName}`);
  }

  async commentOnIssue(repoOwner: string, repoName: string, issueNumber: number, body: string): Promise<void> {
    if (this.config.DRY_RUN) {
      return;
    }

    await this.octokit.issues.createComment({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber,
      body
    });
  }

  async addLabels(repoOwner: string, repoName: string, issueNumber: number, labels: string[]): Promise<void> {
    if (this.config.DRY_RUN || labels.length === 0) {
      return;
    }

    await this.octokit.issues.addLabels({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber,
      labels
    });
  }

  async findOpenPullRequest(repoOwner: string, repoName: string, branchName: string) {
    if (this.config.DRY_RUN) {
      return null;
    }

    const response = await this.octokit.pulls.list({
      owner: repoOwner,
      repo: repoName,
      head: `${repoOwner}:${branchName}`,
      state: "open",
      per_page: 1
    });

    const pull = response.data[0];
    if (!pull) {
      return null;
    }

    return {
      number: pull.number,
      htmlUrl: pull.html_url
    };
  }

  async createOrReusePullRequest(
    repoOwner: string,
    repoName: string,
    branchName: string,
    baseBranch: string,
    title: string,
    body: string
  ) {
    const existing = await this.findOpenPullRequest(repoOwner, repoName, branchName);
    if (existing) {
      return existing;
    }

    if (this.config.DRY_RUN) {
      return { number: 0, htmlUrl: "dry-run://pull-request" };
    }

    const response = await this.octokit.pulls.create({
      owner: repoOwner,
      repo: repoName,
      head: branchName,
      base: baseBranch,
      title,
      body
    });

    return {
      number: response.data.number,
      htmlUrl: response.data.html_url
    };
  }

  async listOpenIssuesSince(
    repoOwner: string,
    repoName: string,
    since: string,
    perPage: number
  ): Promise<GitHubIssueSnapshot[]> {
    const response = await this.octokit.issues.listForRepo({
      owner: repoOwner,
      repo: repoName,
      state: "open",
      sort: "updated",
      direction: "asc",
      since,
      per_page: perPage
    });

    return response.data
      .filter((item) => !("pull_request" in item))
      .map((issue) => GitHubClient.normalizeIssueRecord(issue as unknown as Record<string, unknown>));
  }

  async getIssue(repoOwner: string, repoName: string, issueNumber: number): Promise<GitHubIssueSnapshot> {
    const response = await this.octokit.issues.get({
      owner: repoOwner,
      repo: repoName,
      issue_number: issueNumber
    });

    return GitHubClient.normalizeIssueRecord(response.data as unknown as Record<string, unknown>);
  }

  async listIssueCommentsSince(
    repoOwner: string,
    repoName: string,
    since: string,
    perPage: number
  ): Promise<GitHubIssueCommentEvent[]> {
    const response = await this.octokit.issues.listCommentsForRepo({
      owner: repoOwner,
      repo: repoName,
      since,
      per_page: perPage,
      direction: "asc",
      sort: "updated"
    });

    return response.data.map((comment) => ({
      id: comment.id,
      issueNumber: Number(comment.issue_url.split("/").pop() ?? 0),
      body: comment.body ?? "",
      userLogin: comment.user?.login ?? "",
      createdAt: comment.created_at ?? "",
      updatedAt: comment.updated_at ?? ""
    }));
  }
}
