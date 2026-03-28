import crypto from "node:crypto";
import type { ParsedCommentCommand } from "./types.js";

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function createRunId(): string {
  return crypto.randomUUID();
}

export function parseCommentCommand(input: string): ParsedCommentCommand | null {
  const command = input.trim().split(/\s+/)[0]?.toLowerCase();
  switch (command) {
    case "/status":
      return { command: "status", raw: input };
    case "/retry":
      return { command: "retry", raw: input };
    case "/replan":
      return { command: "replan", raw: input };
    case "/abort":
      return { command: "abort", raw: input };
    default:
      return null;
  }
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(signature);

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
