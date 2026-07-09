import { join } from "node:path";
import YAML from "yaml";
import { readFileSafe } from "../../utils/file-scanner.js";
import type { EvidenceMap } from "./shared.js";

export interface UnityExtraction {
  bundle_id: string | null; // prefer iPhone, fall back Android
  bundle_ids: { ios: string | null; android: string | null };
  app_version: string | null; // PlayerSettings.bundleVersion
  product_name: string | null;
  evidence: EvidenceMap;
}

const PROJECT_SETTINGS_REL = join("ProjectSettings", "ProjectSettings.asset");

/**
 * Strips Unity's YAML preamble (`%YAML`/`%TAG` directives, which the
 * standard `yaml` package's parser rejects) and rewrites the
 * `--- !u!<ClassID> &<FileID>` document marker to a bare `---`. Unity's
 * custom `!u!` tag is only ever used on that one document-marker line in
 * ProjectSettings.asset (a single-document file - class ID 129 is the
 * PlayerSettings singleton), so nothing else in the body needs rewriting.
 */
function toPlainYaml(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("%"))
    .map((line) => (/^---\s*!u!/.test(line) ? "---" : line))
    .join("\n");
}

/**
 * Regex fallback for a malformed/unparseable asset: pulls the
 * `applicationIdentifier:` block directly and reads its `iPhone:`/`Android:`
 * lines. Bounded to the block itself (stops at the next line that returns to
 * <=2-space indentation, i.e. the next sibling PlayerSettings key) so an
 * unrelated key elsewhere in the file can never be picked up by mistake.
 * Never throws.
 */
function regexFallbackAppIds(raw: string): { ios: string | null; android: string | null } {
  const idx = raw.indexOf("applicationIdentifier:");
  if (idx < 0) return { ios: null, android: null };
  const after = raw.slice(idx + "applicationIdentifier:".length);
  const nextSiblingKey = after.search(/\n {0,2}\S/);
  const block = nextSiblingKey >= 0 ? after.slice(0, nextSiblingKey) : after;

  const iphone = block.match(/iPhone:\s*(\S+)/);
  const android = block.match(/Android:\s*(\S+)/);
  return {
    ios: iphone ? iphone[1].trim() : null,
    android: android ? android[1].trim() : null,
  };
}

/**
 * Parses ProjectSettings/ProjectSettings.asset (Unity's serialized
 * PlayerSettings YAML) for the facts the review engine needs: per-platform
 * bundle identifiers, app version, and product name.
 *
 * Never throws: a parse failure falls back to a narrow regex extraction of
 * just the applicationIdentifier block (version/productName are not
 * recovered in that path - the fallback contract only covers bundle ids),
 * and a missing file/directory returns null outright.
 */
export function extractUnityProjectSettings(rootDir: string): UnityExtraction | null {
  const filePath = join(rootDir, "ProjectSettings", "ProjectSettings.asset");
  const raw = readFileSafe(filePath);
  if (raw === null) return null;

  const evidence: EvidenceMap = {
    "unity.project_settings": { file: PROJECT_SETTINGS_REL },
  };

  let ios: string | null = null;
  let android: string | null = null;
  let version: string | null = null;
  let productName: string | null = null;

  try {
    const parsed = YAML.parse(toPlainYaml(raw)) as Record<string, unknown> | null;
    const player = parsed?.PlayerSettings as Record<string, unknown> | undefined;
    if (player && typeof player === "object") {
      const appId = player.applicationIdentifier as Record<string, unknown> | undefined;
      if (appId && typeof appId === "object") {
        ios = typeof appId.iPhone === "string" ? appId.iPhone : null;
        android = typeof appId.Android === "string" ? appId.Android : null;
      }
      version = typeof player.bundleVersion === "string" ? player.bundleVersion : null;
      productName = typeof player.productName === "string" ? player.productName : null;
    }
  } catch {
    // Malformed YAML: never throw - fall back to a narrow regex over just
    // the applicationIdentifier block.
    const fallback = regexFallbackAppIds(raw);
    ios = fallback.ios;
    android = fallback.android;
    evidence["unity.project_settings"] = {
      file: PROJECT_SETTINGS_REL,
      detail: "regex fallback (malformed YAML)",
    };
  }

  return {
    bundle_id: ios ?? android ?? null,
    bundle_ids: { ios, android },
    app_version: version,
    product_name: productName,
    evidence,
  };
}
