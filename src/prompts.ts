import type { ExecutionResult, PlanSpec, ReviewResult, RunRecord } from "./types.js";

export function buildPlanningPrompt(issue: { title: string; body: string }): string {
  return `
You are the planning layer for an autonomous software delivery workflow.
Analyze the GitHub issue and respond with JSON using this exact shape:
{
  "summary": "string",
  "assumptions": ["string"],
  "plan": ["string"],
  "tasks": [{
    "id": "task-1",
    "title": "string",
    "description": "string",
    "paths": ["string"],
    "doneDefinition": "string",
    "risks": ["string"]
  }],
  "acceptanceCriteria": ["string"],
  "testPlan": ["string"],
  "blockingQuestions": ["string"],
  "codexInstruction": "string"
}

Issue title: ${issue.title}
Issue body:
${issue.body}
`;
}

export function buildReviewPrompt(
  issue: { title: string; body: string },
  plan: PlanSpec,
  execution: ExecutionResult
): string {
  return `
You are the review layer for an autonomous software delivery workflow.
Review the execution result against the issue and plan. Respond with JSON:
{
  "approved": true,
  "reviewSummary": "string",
  "requiredFixes": ["string"],
  "prTitle": "string",
  "prBody": "string",
  "issueComment": "string"
}

Issue title: ${issue.title}
Issue body:
${issue.body}

Plan summary: ${plan.summary}
Acceptance criteria:
${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Execution summary: ${execution.summary}
Changed files:
${execution.changedFiles.map((file) => `- ${file}`).join("\n")}

Test results:
${execution.testResults.map((result) => `- ${result}`).join("\n")}

Risks:
${execution.risks.map((risk) => `- ${risk}`).join("\n")}
`;
}

export function buildCodexPrompt(
  issue: { title: string; body: string },
  plan: PlanSpec,
  requiredFixes: string[] = []
): string {
  const taskList = plan.tasks
    .map(
      (task) => `- ${task.id}: ${task.title}
  Description: ${task.description}
  Paths: ${task.paths.join(", ") || "(unspecified)"}
  Done: ${task.doneDefinition}
  Risks: ${task.risks.join(", ") || "(none)"}`
    )
    .join("\n");

  return `
Implement the GitHub issue in the current repository worktree.

Issue:
${issue.title}

Details:
${issue.body}

Plan summary:
${plan.summary}

Tasks:
${taskList}

Acceptance criteria:
${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Test plan:
${plan.testPlan.map((item) => `- ${item}`).join("\n")}

Required fixes from the last review:
${requiredFixes.length > 0 ? requiredFixes.map((item) => `- ${item}`).join("\n") : "- None"}

Extra execution guidance:
${plan.codexInstruction}
`;
}

export function formatPlanComment(plan: PlanSpec): string {
  return `Planning completed.

Summary: ${plan.summary}

Acceptance criteria:
${plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Tasks:
${plan.tasks.map((task) => `- ${task.title}`).join("\n")}`;
}

export function formatBlockingComment(blockingQuestions: string[]): string {
  return `Execution is blocked pending clarification:

${blockingQuestions.map((item) => `- ${item}`).join("\n")}`;
}

export function formatCompletionComment(review: ReviewResult, prUrl: string): string {
  return `${review.issueComment}

Pull request: ${prUrl}`;
}

export function formatStatusComment(
  status: string,
  run: RunRecord | null,
  recentRuns: RunRecord[]
): string {
  const currentRun = run
    ? `Current run: ${run.runId}\nPhase: ${run.phase}\nRun status: ${run.status}\nSummary: ${run.summary ?? "(none)"}`
    : "Current run: none";

  const history =
    recentRuns.length > 0
      ? recentRuns
          .map((item) => `- ${item.runId} ${item.phase}/${item.status}${item.summary ? `: ${item.summary}` : ""}`)
          .join("\n")
      : "- none";

  return `Issue status: ${status}

${currentRun}

Recent runs:
${history}`;
}
