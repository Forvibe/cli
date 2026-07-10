// Single source of truth for the CLI's own version: package.json. Fixes the
// previously hardcoded "0.1.0" in src/index.ts drifting from the published
// package version.

import { createRequire } from "node:module";

const FALLBACK_VERSION = "0.0.0";

/**
 * Reads the CLI package version from package.json, resolved relative to this
 * module's own location (mirrors src/engine/remote.ts's probing pattern).
 *
 * Layouts covered:
 *   - dist build: tsup bundles everything flat into dist/index.js, so
 *     import.meta.url points at <pkg>/dist/index.js -> "../package.json".
 *   - dev / vitest (running from source): this file lives at
 *     <pkg>/src/utils/version.ts -> "../../package.json".
 *
 * The name check guards against accidentally picking up an unrelated
 * package.json from a parent directory.
 */
export function getCliVersion(): string {
  const require = createRequire(import.meta.url);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg?.version && pkg.name === "@forvibe/cli") return pkg.version;
    } catch {
      // Try the next candidate layout.
    }
  }
  return FALLBACK_VERSION;
}
