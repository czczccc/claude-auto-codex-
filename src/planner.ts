import { z } from "zod";
import type { AppConfig } from "./config.js";
import { buildPlanningPrompt, buildReviewPrompt } from "./prompts.js";
import type { ExecutionResult, GitHubIssuePayload, PlanSpec, ReviewResult } from "./types.js";

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  paths: z.array(z.string()).default([]),
  doneDefinition: z.string(),
  risks: z.array(z.string()).default([])
});

const planSchema = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  plan: z.array(z.string()).default([]),
  tasks: z.array(taskSchema).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
  blockingQuestions: z.array(z.string()).default([]),
  codexInstruction: z.string()
});

const reviewSchema = z.object({
  approved: z.boolean(),
  reviewSummary: z.string(),
  requiredFixes: z.array(z.string()).default([]),
  prTitle: z.string(),
  prBody: z.string(),
  issueComment: z.string()
});

export class PlannerAdapter {
  constructor(private readonly config: AppConfig) {}

  async generatePlan(issue: GitHubIssuePayload, signal?: AbortSignal): Promise<PlanSpec> {
    if (this.config.DRY_RUN) {
      return {
        summary: `Implement ${issue.title}`,
        assumptions: ["Dry run mode uses a synthetic plan."],
        plan: ["Analyze the codebase", "Implement the requested change", "Run validation"],
        tasks: [
          {
            id: "task-1",
            title: "Implement issue request",
            description: issue.body || issue.title,
            paths: [],
            doneDefinition: "Requested behavior is implemented and validated.",
            risks: []
          }
        ],
        acceptanceCriteria: ["Requested behavior is present.", "Relevant tests or checks pass."],
        testPlan: ["Run the project's validation command."],
        blockingQuestions: [],
        codexInstruction: "Make the smallest safe change that satisfies the issue."
      };
    }

    const prompt = buildPlanningPrompt(issue);
    const json = await this.invokeModel(prompt, signal);
    return planSchema.parse(JSON.parse(json));
  }

  async reviewExecution(
    issue: GitHubIssuePayload,
    plan: PlanSpec,
    execution: ExecutionResult,
    signal?: AbortSignal
  ): Promise<ReviewResult> {
    if (this.config.DRY_RUN) {
      return {
        approved: execution.status === "success",
        reviewSummary: "Dry run review completed.",
        requiredFixes: execution.status === "success" ? [] : ["Execution failed in dry run mode."],
        prTitle: `feat: resolve issue #${issue.number}`,
        prBody: `Automated change for issue #${issue.number}\n\n${plan.summary}`,
        issueComment: "Automated implementation completed and is ready for review."
      };
    }

    const prompt = buildReviewPrompt(issue, plan, execution);
    const json = await this.invokeModel(prompt, signal);
    return reviewSchema.parse(JSON.parse(json));
  }

  private async invokeModel(prompt: string, signal?: AbortSignal): Promise<string> {
    const response = await fetch(`${this.config.PLANNER_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.PLANNER_API_KEY}`
      },
      body: JSON.stringify({
        model: this.config.PLANNER_MODEL,
        messages: [
          {
            role: "system",
            content: "Always return valid JSON with no markdown fences."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(`Planner API failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Planner API returned no content");
    }

    return content;
  }
}
