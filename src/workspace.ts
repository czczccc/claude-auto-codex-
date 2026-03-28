import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slugify } from "./utils.js";

const execFileAsync = promisify(execFile);

export class WorkspaceManager {
  constructor(private readonly worktreeRoot: string, private readonly repoRoot: string) {
    fs.mkdirSync(worktreeRoot, { recursive: true });
  }

  createBranchName(issueNumber: number, title: string): string {
    return `issue/${issueNumber}-${slugify(title) || "work-item"}`;
  }

  getRepoPath(repoOwner: string, repoName: string): string {
    return path.resolve(this.repoRoot, repoOwner, repoName);
  }

  getWorktreePath(repoOwner: string, repoName: string, issueNumber: number): string {
    return path.resolve(this.worktreeRoot, repoOwner, repoName, `issue-${issueNumber}`);
  }

  ensureRepositoryExists(localPath: string): void {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Local repository not found at ${localPath}. Clone it before enabling automation.`);
    }
  }

  async ensureBaseBranch(localPath: string, baseBranch: string): Promise<void> {
    await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: localPath });
  }

  async ensureWorktree(
    localPath: string,
    repoOwner: string,
    repoName: string,
    branchName: string,
    issueNumber: number,
    baseBranch: string
  ): Promise<string> {
    this.ensureRepositoryExists(localPath);

    const worktreePath = this.getWorktreePath(repoOwner, repoName, issueNumber);
    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await this.ensureBaseBranch(localPath, baseBranch);
    await execFileAsync(
      "git",
      ["worktree", "add", "-B", branchName, worktreePath, `origin/${baseBranch}`],
      { cwd: localPath }
    );

    return worktreePath;
  }

  async getChangedFiles(worktreePath: string): Promise<string[]> {
    const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: worktreePath });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z?]+\s+/, ""));
  }

  async getDiffSummary(worktreePath: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["diff", "--stat"], { cwd: worktreePath });
    return stdout.trim();
  }

  async commitChanges(worktreePath: string, issueNumber: number): Promise<boolean> {
    const changedFiles = await this.getChangedFiles(worktreePath);
    if (changedFiles.length === 0) {
      return false;
    }

    await execFileAsync("git", ["add", "-A"], { cwd: worktreePath });
    await execFileAsync("git", ["commit", "-m", `feat: resolve issue #${issueNumber}`], {
      cwd: worktreePath
    });
    return true;
  }

  async pushBranch(worktreePath: string, branchName: string): Promise<void> {
    await execFileAsync("git", ["push", "--set-upstream", "origin", branchName], {
      cwd: worktreePath
    });
  }
}
