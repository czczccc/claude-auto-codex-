# claude-auto-codex

GitHub issue driven local automation service:

- listens for GitHub issue webhooks
- asks Claude planning layer for a structured plan
- runs Codex in a per-issue git worktree
- reviews the result
- pushes a branch and opens a PR

## Multi-repo model

One service can manage many repositories.

- local clones live under `REPO_ROOT/<owner>/<repo>`
- issue worktrees live under `WORKTREE_ROOT/<owner>/<repo>/issue-<number>`
- SQLite stores workflow state for all repositories in one file

Example local layout:

```text
repos/
  acme/
    api-service/
    web-app/
data/
  orchestrator.sqlite
  worktrees/
    acme/
      api-service/
        issue-12/
```

## Setup

1. Clone each target repository into `REPO_ROOT/<owner>/<repo>`.
2. Copy `.env.example` to `.env` and fill in GitHub token, webhook secret, and planner API settings.
3. Copy `repositories.example.json` to `repositories.json` and register each managed repository.
4. Set `REPO_ALLOWLIST` to the repositories this service may automate.
5. Install dependencies with `npm install`.
6. Start the server with `npm run dev` or `npm start`.

## Required environment

- `GITHUB_APP_WEBHOOK_SECRET`: webhook signing secret
- `GITHUB_TOKEN`: token with issue and pull request write access
- `REPO_ROOT`: parent directory containing local clones
- `REPO_CONFIG_PATH`: structured repository registry file
- `WORKTREE_ROOT`: parent directory for per-issue git worktrees
- `DB_PATH`: SQLite file path
- `REPO_ALLOWLIST`: comma-separated `owner/repo` list
- `PLANNER_API_BASE_URL`
- `PLANNER_API_KEY`
- `PLANNER_MODEL`

## Webhook behavior

The server accepts GitHub webhooks on `/webhooks/github`.

- registered repositories only
- issues are processed only when the repository-specific auto label is present
- supported issue actions: `opened`, `labeled`
- supported comment commands:
  - `/status`
  - `/retry`
  - `/replan`
  - `/abort`

There is also a local status endpoint:

- `GET /runs/:owner/:repo/:issueNumber`

## Current v1 limitations

- assumes the repository is already cloned locally
- comment command authorization is based on configured GitHub usernames
- abort is best-effort and depends on the current tool subprocess honoring termination
