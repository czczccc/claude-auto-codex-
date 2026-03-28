import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { IssueRecord, IssueStatus, RunPhase, RunRecord, RunStatus, RunTrigger } from "./types.js";

export class StateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        branch_name TEXT,
        worktree_path TEXT,
        pr_number INTEGER,
        last_error TEXT,
        active_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, issue_number)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        error_message TEXT,
        abort_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        run_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, artifact_type)
      );

      CREATE TABLE IF NOT EXISTS dedupe_events (
        delivery_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_poll_state (
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        issue_cursor TEXT,
        comment_cursor TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_owner, repo_name)
      );

      CREATE TABLE IF NOT EXISTS processed_issue_comments (
        comment_id INTEGER PRIMARY KEY,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_observations (
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        has_auto_label INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_owner, repo_name, issue_number)
      );
    `);
  }

  getRepoPollState(
    repoOwner: string,
    repoName: string
  ): { issueCursor: string | null; commentCursor: string | null } {
    const row = this.db
      .prepare(`
        SELECT
          issue_cursor AS issueCursor,
          comment_cursor AS commentCursor
        FROM repo_poll_state
        WHERE repo_owner = ? AND repo_name = ?
      `)
      .get(repoOwner, repoName) as { issueCursor: string | null; commentCursor: string | null } | undefined;

    return row ?? { issueCursor: null, commentCursor: null };
  }

  setRepoPollState(
    repoOwner: string,
    repoName: string,
    patch: { issueCursor?: string | null; commentCursor?: string | null }
  ): void {
    const existing = this.getRepoPollState(repoOwner, repoName);
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO repo_poll_state (repo_owner, repo_name, issue_cursor, comment_cursor, updated_at)
        VALUES (@repoOwner, @repoName, @issueCursor, @commentCursor, @updatedAt)
        ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
          issue_cursor = excluded.issue_cursor,
          comment_cursor = excluded.comment_cursor,
          updated_at = excluded.updated_at
      `)
      .run({
        repoOwner,
        repoName,
        issueCursor: patch.issueCursor ?? existing.issueCursor,
        commentCursor: patch.commentCursor ?? existing.commentCursor,
        updatedAt: now
      });
  }

  hasProcessedIssueComment(commentId: number): boolean {
    const row = this.db
      .prepare("SELECT comment_id FROM processed_issue_comments WHERE comment_id = ?")
      .get(commentId);
    return Boolean(row);
  }

  recordProcessedIssueComment(
    commentId: number,
    repoOwner: string,
    repoName: string,
    issueNumber: number
  ): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO processed_issue_comments (
          comment_id, repo_owner, repo_name, issue_number, processed_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(commentId, repoOwner, repoName, issueNumber, new Date().toISOString());
  }

  getIssueObservation(
    repoOwner: string,
    repoName: string,
    issueNumber: number
  ): { hasAutoLabel: boolean } | null {
    const row = this.db
      .prepare(`
        SELECT has_auto_label AS hasAutoLabel
        FROM issue_observations
        WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
      `)
      .get(repoOwner, repoName, issueNumber) as { hasAutoLabel: number } | undefined;

    if (!row) {
      return null;
    }

    return { hasAutoLabel: Boolean(row.hasAutoLabel) };
  }

  setIssueObservation(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    hasAutoLabel: boolean
  ): void {
    this.db
      .prepare(`
        INSERT INTO issue_observations (
          repo_owner, repo_name, issue_number, has_auto_label, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repo_owner, repo_name, issue_number) DO UPDATE SET
          has_auto_label = excluded.has_auto_label,
          updated_at = excluded.updated_at
      `)
      .run(repoOwner, repoName, issueNumber, hasAutoLabel ? 1 : 0, new Date().toISOString());
  }

  hasDelivery(deliveryId: string): boolean {
    const row = this.db
      .prepare("SELECT delivery_id FROM dedupe_events WHERE delivery_id = ?")
      .get(deliveryId);
    return Boolean(row);
  }

  recordDelivery(deliveryId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO dedupe_events (delivery_id, received_at) VALUES (?, ?)")
      .run(deliveryId, new Date().toISOString());
  }

  upsertIssue(issue: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    issueId: number;
    title: string;
    body: string;
    status: IssueStatus;
  }): IssueRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO issues (
          repo_owner, repo_name, issue_number, issue_id, title, body, status, created_at, updated_at
        ) VALUES (
          @repoOwner, @repoName, @issueNumber, @issueId, @title, @body, @status, @createdAt, @updatedAt
        )
        ON CONFLICT(repo_owner, repo_name, issue_number) DO UPDATE SET
          issue_id = excluded.issue_id,
          title = excluded.title,
          body = excluded.body,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run({
        ...issue,
        createdAt: now,
        updatedAt: now
      });

    return this.getIssue(issue.repoOwner, issue.repoName, issue.issueNumber)!;
  }

  getIssue(repoOwner: string, repoName: string, issueNumber: number): IssueRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          repo_owner AS repoOwner,
          repo_name AS repoName,
          issue_number AS issueNumber,
          issue_id AS issueId,
          title,
          body,
          status,
          branch_name AS branchName,
          worktree_path AS worktreePath,
          pr_number AS prNumber,
          last_error AS lastError,
          active_run_id AS activeRunId,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM issues
        WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
      `)
      .get(repoOwner, repoName, issueNumber) as IssueRecord | undefined;

    return row ?? null;
  }

  updateIssueState(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    patch: Partial<
      Pick<
        IssueRecord,
        "status" | "branchName" | "worktreePath" | "prNumber" | "lastError" | "activeRunId"
      >
    >
  ): void {
    const existing = this.getIssue(repoOwner, repoName, issueNumber);
    if (!existing) {
      throw new Error(`Issue ${repoOwner}/${repoName}#${issueNumber} not found`);
    }

    this.db
      .prepare(`
        UPDATE issues
        SET status = @status,
            branch_name = @branchName,
            worktree_path = @worktreePath,
            pr_number = @prNumber,
            last_error = @lastError,
            active_run_id = @activeRunId,
            updated_at = @updatedAt
        WHERE repo_owner = @repoOwner AND repo_name = @repoName AND issue_number = @issueNumber
      `)
      .run({
        repoOwner,
        repoName,
        issueNumber,
        status: patch.status ?? existing.status,
        branchName: patch.branchName ?? existing.branchName,
        worktreePath: patch.worktreePath ?? existing.worktreePath,
        prNumber: patch.prNumber ?? existing.prNumber,
        lastError: patch.lastError ?? existing.lastError,
        activeRunId: patch.activeRunId ?? existing.activeRunId,
        updatedAt: new Date().toISOString()
      });
  }

  createRun(run: {
    runId: string;
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    trigger: RunTrigger;
  }): RunRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO runs (
          run_id, repo_owner, repo_name, issue_number, trigger_type, phase, status, created_at, updated_at
        ) VALUES (
          @runId, @repoOwner, @repoName, @issueNumber, @trigger, @phase, @status, @createdAt, @updatedAt
        )
      `)
      .run({
        ...run,
        phase: "queued",
        status: "queued",
        createdAt: now,
        updatedAt: now
      });

    return this.getRun(run.runId)!;
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id AS runId,
          repo_owner AS repoOwner,
          repo_name AS repoName,
          issue_number AS issueNumber,
          trigger_type AS trigger,
          phase,
          status,
          summary,
          error_message AS errorMessage,
          abort_requested_at AS abortRequestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM runs
        WHERE run_id = ?
      `)
      .get(runId) as RunRecord | undefined;

    return row ?? null;
  }

  getLatestRun(repoOwner: string, repoName: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id AS runId,
          repo_owner AS repoOwner,
          repo_name AS repoName,
          issue_number AS issueNumber,
          trigger_type AS trigger,
          phase,
          status,
          summary,
          error_message AS errorMessage,
          abort_requested_at AS abortRequestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM runs
        WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(repoOwner, repoName, issueNumber) as RunRecord | undefined;

    return row ?? null;
  }

  listRuns(repoOwner: string, repoName: string, issueNumber: number, limit = 10): RunRecord[] {
    return this.db
      .prepare(`
        SELECT
          run_id AS runId,
          repo_owner AS repoOwner,
          repo_name AS repoName,
          issue_number AS issueNumber,
          trigger_type AS trigger,
          phase,
          status,
          summary,
          error_message AS errorMessage,
          abort_requested_at AS abortRequestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM runs
        WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(repoOwner, repoName, issueNumber, limit) as RunRecord[];
  }

  getActiveRun(repoOwner: string, repoName: string, issueNumber: number): RunRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id AS runId,
          repo_owner AS repoOwner,
          repo_name AS repoName,
          issue_number AS issueNumber,
          trigger_type AS trigger,
          phase,
          status,
          summary,
          error_message AS errorMessage,
          abort_requested_at AS abortRequestedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM runs
        WHERE repo_owner = ? AND repo_name = ? AND issue_number = ?
          AND status IN ('queued', 'in_progress')
        ORDER BY created_at DESC
        LIMIT 1
      `)
      .get(repoOwner, repoName, issueNumber) as RunRecord | undefined;

    return row ?? null;
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, "phase" | "status" | "summary" | "errorMessage" | "abortRequestedAt">>
  ): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run ${runId} not found`);
    }

    this.db
      .prepare(`
        UPDATE runs
        SET phase = @phase,
            status = @status,
            summary = @summary,
            error_message = @errorMessage,
            abort_requested_at = @abortRequestedAt,
            updated_at = @updatedAt
        WHERE run_id = @runId
      `)
      .run({
        runId,
        phase: patch.phase ?? existing.phase,
        status: patch.status ?? existing.status,
        summary: patch.summary ?? existing.summary,
        errorMessage: patch.errorMessage ?? existing.errorMessage,
        abortRequestedAt: patch.abortRequestedAt ?? existing.abortRequestedAt,
        updatedAt: new Date().toISOString()
      });
  }

  setRunPhase(runId: string, phase: RunPhase, summary?: string | null): void {
    this.updateRun(runId, {
      phase,
      status: phase === "queued" ? "queued" : "in_progress",
      summary: summary ?? undefined
    });
  }

  completeRun(runId: string, status: Extract<RunStatus, "completed" | "blocked" | "failed" | "aborted">, summary?: string): void {
    const phaseMap: Record<typeof status, RunPhase> = {
      completed: "completed",
      blocked: "blocked",
      failed: "failed",
      aborted: "aborted"
    };
    this.updateRun(runId, {
      phase: phaseMap[status],
      status,
      summary
    });
  }

  requestAbort(runId: string): void {
    this.updateRun(runId, {
      abortRequestedAt: new Date().toISOString()
    });
  }

  isAbortRequested(runId: string): boolean {
    const run = this.getRun(runId);
    return Boolean(run?.abortRequestedAt);
  }

  storeArtifact(runId: string, artifactType: string, content: string): void {
    this.db
      .prepare(`
        INSERT INTO artifacts (run_id, artifact_type, content, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, artifact_type) DO UPDATE SET
          content = excluded.content,
          created_at = excluded.created_at
      `)
      .run(runId, artifactType, content, new Date().toISOString());
  }

  getArtifact(runId: string, artifactType: string): string | null {
    const row = this.db
      .prepare("SELECT content FROM artifacts WHERE run_id = ? AND artifact_type = ?")
      .get(runId, artifactType) as { content: string } | undefined;
    return row?.content ?? null;
  }

  markInterruptedRunsFailed(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        UPDATE runs
        SET phase = 'failed',
            status = 'failed',
            error_message = COALESCE(error_message, 'Service restarted while run was active.'),
            updated_at = ?
        WHERE status IN ('queued', 'in_progress')
      `)
      .run(now);

    this.db
      .prepare(`
        UPDATE issues
        SET status = 'failed',
            last_error = COALESCE(last_error, 'Service restarted while run was active.'),
            active_run_id = NULL,
            updated_at = ?
        WHERE active_run_id IS NOT NULL
      `)
      .run(now);

    return result.changes;
  }
}
