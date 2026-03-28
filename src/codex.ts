import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import type { ExecutionResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const execFileAsync = promisify(execFile);

export class CodexRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly workspace: WorkspaceManager
  ) {}

  async execute(
    worktreePath: string,
    prompt: string,
    testCommands: string[],
    signal?: AbortSignal
  ): Promise<ExecutionResult> {
    if (signal?.aborted) {
      throw new Error("Execution aborted before Codex started.");
    }

    if (this.config.DRY_RUN) {
      return {
        status: "success",
        summary: "Dry run execution completed.",
        changedFiles: [],
        testCommands,
        testResults: ["Dry run mode skipped Codex execution."],
        risks: [],
        rawOutput: ""
      };
    }

    const args = this.config.CODEX_ARGS.split(" ").filter(Boolean);
    const { stdout, stderr } = await this.runCommand(worktreePath, args, prompt, signal);
    const changedFiles = await this.workspace.getChangedFiles(worktreePath);
    const testResults = await this.runTests(worktreePath, testCommands, signal);
    const diffSummary = await this.workspace.getDiffSummary(worktreePath);
    const output = `${stdout}\n${stderr}`.trim();

    return {
      status: "success",
      summary: diffSummary || "Codex execution completed.",
      changedFiles,
      testCommands,
      testResults,
      risks: [],
      rawOutput: output
    };
  }

  private async runTests(
    worktreePath: string,
    testCommands: string[],
    signal?: AbortSignal
  ): Promise<string[]> {
    const results: string[] = [];

    for (const command of testCommands) {
      if (signal?.aborted) {
        throw new Error("Execution aborted during test phase.");
      }

      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
          cwd: worktreePath,
          maxBuffer: 1024 * 1024 * 8
        });
        const trimmed = `${stdout}\n${stderr}`.trim();
        results.push(`PASS: ${command}${trimmed ? `\n${trimmed}` : ""}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push(`FAIL: ${command}\n${message}`);
        throw new Error(`Test command failed: ${command}`);
      }
    }

    return results;
  }

  private runCommand(
    worktreePath: string,
    args: string[],
    prompt: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.CODEX_COMMAND, args, {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      const onAbort = () => {
        child.kill("SIGTERM");
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(error);
      });

      child.on("close", (code, signalName) => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }

        if (signalName === "SIGTERM" || signal?.aborted) {
          reject(new Error("Codex command aborted."));
          return;
        }

        if (code !== 0) {
          reject(new Error(`Codex command exited with code ${code}\n${stderr}`));
          return;
        }

        resolve({ stdout, stderr });
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
