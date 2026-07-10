import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, "..", "..");
const SCRIPT_SRC = path.join(REPO_ROOT, "scripts", "sync-rulepack.mjs");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "content-mini");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// scripts/sync-rulepack.mjs always writes to <its-own-repo-root>/src/engine/data/bundle.appstore.json,
// resolved relative to the script file's own location (not process.cwd()).
// To exercise it without ever touching the real committed snapshot, each
// test copies the script into an isolated throwaway "repo root" and runs it
// from there - the copy's own location becomes its "repo root".
async function createSandbox(): Promise<string> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "sync-rulepack-"));
  await mkdir(path.join(sandbox, "scripts"), { recursive: true });
  await cp(SCRIPT_SRC, path.join(sandbox, "scripts", "sync-rulepack.mjs"));
  return sandbox;
}

async function runSandboxed(sandbox: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      path.join(sandbox, "scripts", "sync-rulepack.mjs"),
      ...args,
    ]);
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
  }
}

describe("scripts/sync-rulepack.mjs", () => {
  it("--from-dir writes a RulepackBundle with merged stories and correct counts", async () => {
    const sandbox = await createSandbox();
    try {
      const { exitCode, stdout } = await runSandboxed(sandbox, ["--from-dir", FIXTURE_DIR]);
      expect(exitCode).toBe(0);

      const outPath = path.join(sandbox, "src", "engine", "data", "bundle.appstore.json");
      const bundle = JSON.parse(await readFile(outPath, "utf-8"));

      expect(bundle.schema_version).toBe(1);
      expect(bundle.store).toBe("appstore");
      expect(bundle.version).toBe("0.0.1-mini");
      expect(bundle.updated_at).toBe("2026-01-01");

      expect(bundle.rules).toHaveLength(1);
      expect(bundle.rules[0].id).toBe("appstore.mini-test-rule");

      expect(bundle.sdk_registry).toHaveLength(1);
      expect(bundle.sdk_registry[0].id).toBe("mini-sdk");

      // Merged from the two files under stories/ into one flat array.
      expect(bundle.stories).toHaveLength(2);
      expect(bundle.stories.map((s: { id: string }) => s.id).sort()).toEqual([
        "mini-story-a",
        "mini-story-b",
      ]);

      expect(Object.keys(bundle.guidelines)).toEqual(["1.1"]);

      // Printed summary: previous version ("none" - first run in a fresh
      // sandbox) -> new version, plus the counts.
      expect(stdout).toContain("none -> 0.0.1-mini");
      expect(stdout).toContain("rules=1 sdks=1 stories=2 guidelines=1");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("re-running reports the previous version rather than 'none'", async () => {
    const sandbox = await createSandbox();
    try {
      const first = await runSandboxed(sandbox, ["--from-dir", FIXTURE_DIR]);
      expect(first.exitCode).toBe(0);

      const second = await runSandboxed(sandbox, ["--from-dir", FIXTURE_DIR]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("0.0.1-mini -> 0.0.1-mini");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("exits non-zero with a readable message when the content dir does not exist", async () => {
    const sandbox = await createSandbox();
    try {
      const missingDir = path.join(FIXTURE_DIR, "does-not-exist");
      const { exitCode, stderr } = await runSandboxed(sandbox, ["--from-dir", missingDir]);
      expect(exitCode).not.toBe(0);
      expect(stderr.toLowerCase()).toContain("not found");
      expect(stderr).toContain(missingDir);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
