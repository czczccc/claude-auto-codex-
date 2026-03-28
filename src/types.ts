export type IssueStatus =
  | "received"
  | "planning"
  | "planned"
  | "executing"
  | "reviewing"
  | "push_failed"
  | "pr_opened"
  | "completed"
  | "blocked"
  | "failed"
  | "aborted";

export type RunPhase =
  | "queued"
  | "planning"
  | "planned"
  | "executing"
  | "reviewing"
  | "completed"
  | "blocked"
  | "failed"
  | "aborted";

export type RunStatus = "queued" | "in_progress" | "completed" | "blocked" | "failed" | "aborted";

export type RunTrigger = "issue_opened" | "issue_labeled" | "retry" | "replan";

export type CommentCommand = "status" | "retry" | "replan" | "abort";

export interface IssueLabel {
  name: string;
}

export interface GitHubIssuePayload {
  id: number;
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  labels: IssueLabel[];
  userLogin: string;
}

export interface IssueRecord {
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  issueId: number;
  title: string;
  body: string;
  status: IssueStatus;
  branchName: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  lastError: string | null;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  runId: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  trigger: RunTrigger;
  phase: RunPhase;
  status: RunStatus;
  summary: string | null;
  errorMessage: string | null;
  abortRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  paths: string[];
  doneDefinition: string;
  risks: string[];
}

export interface PlanSpec {
  summary: string;
  assumptions: string[];
  plan: string[];
  tasks: TaskSpec[];
  acceptanceCriteria: string[];
  testPlan: string[];
  blockingQuestions: string[];
  codexInstruction: string;
}

export interface ExecutionResult {
  status: "success" | "failed";
  summary: string;
  changedFiles: string[];
  testCommands: string[];
  testResults: string[];
  risks: string[];
  rawOutput: string;
}

export interface ReviewResult {
  approved: boolean;
  reviewSummary: string;
  requiredFixes: string[];
  prTitle: string;
  prBody: string;
  issueComment: string;
}

export interface RepositoryConfig {
  owner: string;
  repo: string;
  localPath?: string;
  baseBranch?: string;
  autoLabel?: string;
  allowedCommenters?: string[];
  testCommands?: string[];
}

export interface ResolvedRepositoryConfig {
  owner: string;
  repo: string;
  localPath: string;
  baseBranch: string;
  autoLabel: string;
  allowedCommenters: string[];
  testCommands: string[];
}

export interface OrchestratorIssueContext {
  issue: GitHubIssuePayload;
  repoOwner: string;
  repoName: string;
  baseBranch: string;
  repositoryConfig: ResolvedRepositoryConfig;
}

export interface GitHubCommentPayload {
  body: string;
  userLogin: string;
}

export interface OrchestratorCommentContext extends OrchestratorIssueContext {
  comment: GitHubCommentPayload;
}

export interface ParsedCommentCommand {
  command: CommentCommand;
  raw: string;
}
