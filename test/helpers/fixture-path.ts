import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolves `test/fixtures/<name>` to an absolute path for use as an extractor rootDir. */
export function fixturePath(name: string): string {
  return path.join(__dirname, "..", "fixtures", name);
}
