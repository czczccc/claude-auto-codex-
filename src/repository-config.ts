import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { RepositoryConfig, ResolvedRepositoryConfig } from "./types.js";

const repositorySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  localPath: z.string().optional(),
  baseBranch: z.string().optional(),
  autoLabel: z.string().optional(),
  allowedCommenters: z.array(z.string()).optional(),
  testCommands: z.array(z.string()).optional()
});

const repositoryConfigFileSchema = z.object({
  repositories: z.array(repositorySchema).default([])
});

export class RepositoryRegistry {
  private readonly repositories = new Map<string, ResolvedRepositoryConfig>();

  constructor(config: AppConfig) {
    const filePath = path.resolve(config.REPO_CONFIG_PATH);
    const payload = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8"))
      : { repositories: [] };
    const parsed = repositoryConfigFileSchema.parse(payload);

    for (const repo of parsed.repositories) {
      const resolved = this.resolveRepository(config, repo);
      this.repositories.set(`${resolved.owner}/${resolved.repo}`, resolved);
    }
  }

  get(repoOwner: string, repoName: string): ResolvedRepositoryConfig | null {
    return this.repositories.get(`${repoOwner}/${repoName}`) ?? null;
  }

  has(repoOwner: string, repoName: string): boolean {
    return this.repositories.has(`${repoOwner}/${repoName}`);
  }

  list(): ResolvedRepositoryConfig[] {
    return Array.from(this.repositories.values());
  }

  private resolveRepository(config: AppConfig, repo: RepositoryConfig): ResolvedRepositoryConfig {
    return {
      owner: repo.owner,
      repo: repo.repo,
      localPath: repo.localPath
        ? path.resolve(repo.localPath)
        : path.resolve(config.REPO_ROOT, repo.owner, repo.repo),
      baseBranch: repo.baseBranch ?? config.GITHUB_DEFAULT_BASE_BRANCH,
      autoLabel: repo.autoLabel ?? config.GITHUB_AUTO_LABEL,
      allowedCommenters: repo.allowedCommenters ?? [],
      testCommands: repo.testCommands ?? []
    };
  }
}
