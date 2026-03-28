import path from "node:path";
import { loadConfig } from "./config.js";
import { CodexRunner } from "./codex.js";
import { StateStore } from "./db.js";
import { GitHubClient } from "./github.js";
import { createLogger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { PlannerAdapter } from "./planner.js";
import { RepositoryRegistry } from "./repository-config.js";
import { createServer } from "./server.js";
import { WorkspaceManager } from "./workspace.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const store = new StateStore(path.resolve(config.DB_PATH));
  const repositoryRegistry = new RepositoryRegistry(config);
  const github = new GitHubClient(config);
  const planner = new PlannerAdapter(config);
  const workspace = new WorkspaceManager(
    path.resolve(config.WORKTREE_ROOT),
    path.resolve(config.REPO_ROOT)
  );
  const codex = new CodexRunner(config, workspace);
  const orchestrator = new Orchestrator(config, store, github, planner, codex, workspace, logger);
  const recoveredRuns = store.markInterruptedRunsFailed();
  if (recoveredRuns > 0) {
    logger.warn({ recoveredRuns }, "Marked interrupted runs as failed during startup");
  }
  const app = createServer(config, store, github, repositoryRegistry, orchestrator, logger);

  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Server listening");
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
