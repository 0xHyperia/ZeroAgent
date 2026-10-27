#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "./release-version.mjs";

const DEFAULT_MODEL = "gpt-5.5";
const MAX_CONTEXT_CHARS = 22000;

const [releaseTagArg, outputPath, fallbackNotesPath] = process.argv.slice(2);

function usage() {
  return "Usage: create-ai-release-notes.mjs <release-tag> <output-path> [fallback-notes-file]";
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

let releaseVersion;

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (options.optional) return "";
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function compact(value, maxChars = MAX_CONTEXT_CHARS) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function fallbackNotes() {
  if (fallbackNotesPath) {
    try {
      const fallback = readFileSync(fallbackNotesPath, "utf8").trim();
      if (fallback) return fallback;
    } catch {
      // Fall through to a minimal note.
    }
  }
  return `# ZeroAgent ${releaseVersion.releaseTag}\n\nRelease ${releaseVersion.releaseTag}.`;
}

function writeFallback(reason) {
  console.warn(`AI release notes unavailable: ${reason}`);
  if (fallbackNotesPath) {
    try {
      copyFileSync(fallbackNotesPath, outputPath);
      console.log(`Wrote fallback release notes: ${outputPath}`);
      return;
    } catch {
      // Fall through to generated fallback notes.
    }
  }
  writeFileSync(outputPath, `${fallbackNotes()}\n`);
  console.log(`Wrote fallback release notes: ${outputPath}`);
}

function stripCodeFence(markdown) {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

export function normalizeMarkdown(markdown, tag = releaseVersion?.releaseTag) {
  let output = stripCodeFence(markdown);
  if (!output) return "";
  const heading = `# ZeroAgent ${tag}`;
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return "";
  output = lines.slice(start).join("\n");
  return `${output.trim()}\n`;
}

function previousTagFor(releaseCommit) {
  return runGit(["describe", "--tags", "--abbrev=0", `${releaseCommit}^`], {
    optional: true,
  });
}

function collectContext() {
  const releaseCommit = runGit(["rev-list", "-n", "1", releaseVersion.releaseTag]);
  const previousTag = previousTagFor(releaseCommit);
  const range = previousTag ? `${previousTag}..${releaseCommit}` : releaseCommit;
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "tkxs/ZeroAgent";

  const commitLog = runGit([
    "log",
    "--date=short",
    "--format=%h%x09%ad%x09%an%x09%s",
    range,
  ]);
  const diffStat = previousTag
    ? runGit(["diff", "--stat", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--stat", "--oneline", "--no-renames", releaseCommit], { optional: true });
  const changedFiles = previousTag
    ? runGit(["diff", "--name-status", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--name-status", "--format=", releaseCommit], { optional: true });
  const githubNotes = fallbackNotesPath
    ? readFileSync(fallbackNotesPath, "utf8").trim()
    : "";

  return {
    appVersion: releaseVersion.appVersion,
    changedFiles: compact(changedFiles, 7000),
    commitLog: compact(commitLog, 10000),
    diffStat: compact(diffStat, 7000),
    githubNotes: compact(githubNotes, 8000),
    previousTag,
    range,
    releaseCommit,
    releaseTag: releaseVersion.releaseTag,
    repository,
  };
}

function buildPrompt(context) {
  return [
    `Repository: ${context.repository}`,
    `Release tag: ${context.releaseTag}`,
    `App version: ${context.appVersion}`,
    `Previous tag: ${context.previousTag || "none"}`,
    `Commit range: ${context.range}`,
    "",
    "Write polished GitHub release notes in Markdown for this release.",
    "",
    "Rules:",
    "- Output Markdown only.",
    "- Do not invent features, fixes, metrics, dates, warnings, contributors, or compatibility claims.",
    "- Use only the provided GitHub notes, commit log, diff stat, and changed files.",
    "- Write for end users first, developers second.",
    "- Start with exactly this H1: # ZeroAgent " + context.releaseTag,
    "- Add a one-sentence blockquote summary after the H1.",
    "- Use concise sections: Overview, Highlights, Added, Changed, Fixed, Internal.",
    "- Omit a section if there is no evidence for it.",
    "- Keep the release notes useful and skimmable, not a raw commit dump.",
    "- Mention PR numbers and contributors only when present in the context.",
    "",
    "GitHub generated notes:",
    "```markdown",
    context.githubNotes || "(none)",
    "```",
    "",
    "Commit log:",
    "```text",
    context.commitLog || "(none)",
    "```",
    "",
    "Diff stat:",
    "```text",
    context.diffStat || "(none)",
    "```",
    "",
    "Changed files:",
    "```text",
    context.changedFiles || "(none)",
    "```",
  ].join("\n");
}

function isReasoningOutput(type) { return /^(analysis|reasoning|summary)(?:_|$)/.test(String(type)); }

export function responseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;

  const output = payload.output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      if (!item || isReasoningOutput(item.type)) continue;
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (content && !isReasoningOutput(content.type) && typeof content.text === "string") parts.push(content.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) {
    return choice
      .filter((part) => part && !isReasoningOutput(part.type))
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function main() {
  const token = process.env.ZEROAGENT_BACKEND_TOKEN?.trim();
  if (!token) { writeFallback("missing ZEROAGENT_BACKEND_TOKEN"); return; }
  const baseUrl = (process.env.ZEROAGENT_BACKEND_URL?.trim() || "http://127.0.0.1:47321").replace(/\/+$/, "");
  const provider = process.env.AI_RELEASE_NOTES_PROVIDER?.trim() || "usa-zero";
  const model = process.env.AI_RELEASE_NOTES_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = Number.parseInt(process.env.AI_RELEASE_NOTES_TIMEOUT_MS ?? "60000", 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 60000);
  try {
    const context = collectContext();
    const response = await fetch(baseUrl + "/v1/text/generate", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: {provider, model}, output: "text", messages: [
        {role:"system",content:[{type:"text",text:"Write accurate ZeroAgent release notes from the supplied evidence. Never include reasoning, secrets or unsupported claims."}]},
        {role:"user",content:[{type:"text",text:buildPrompt(context)}]}
      ]}),
    });
    if (!response.ok) throw new Error("K-brain text generation failed (" + response.status + ")");
    const payload = await response.json();
    if (payload.version !== "kbrain.agent.v1" || payload.model?.provider !== provider || payload.model?.model !== model) throw new Error("K-brain text generation identity mismatch");
    const markdown = normalizeMarkdown(typeof payload.text === "string" ? payload.text : "");
    if (!markdown) { writeFallback("model returned no valid ZeroAgent release notes"); return; }
    writeFileSync(outputPath, markdown);
    console.log("Wrote release notes through K-brain: " + outputPath);
  } catch (error) { writeFallback(error instanceof Error ? error.message : String(error)); }
  finally { clearTimeout(timeout); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!releaseTagArg || !outputPath) fail(usage());
  try { releaseVersion = parseReleaseVersion(releaseTagArg); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  main();
}
