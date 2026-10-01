import { readFileSync, statSync } from "fs";
import { basename, extname, relative } from "path";
import type { ForvibeClient } from "../api/forvibe-client.js";
import type { CLIAppAsset } from "../types/report.js";

function mimeForPath(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export async function uploadAssetsToStorage(
  client: ForvibeClient,
  rootDir: string,
  assets: CLIAppAsset[],
  appIconPath: string | null
): Promise<CLIAppAsset[]> {
  // Build a parallel array of { asset metadata, binary buffer }.
  type Pending = { asset: CLIAppAsset; buffer: Buffer };
  const pending: Pending[] = [];

  for (const asset of assets) {
    if (!asset.base64_data) continue;
    pending.push({
      asset,
      buffer: Buffer.from(asset.base64_data, "base64"),
    });
  }

  // Attach app icon as a first-class asset (if present and within size cap).
  // SVG icons cannot be stored as PNG/JPEG/WebP; skip them rather than upload a mislabeled file.
  if (appIconPath && extname(appIconPath).toLowerCase() !== ".svg") {
    try {
      const stat = statSync(appIconPath);
      if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
        const buffer = readFileSync(appIconPath);
        pending.push({
          asset: {
            asset_type: "app_icon",
            file_name: basename(appIconPath),
            mime_type: mimeForPath(appIconPath),
            width: null,
            height: null,
            source_path: relative(rootDir, appIconPath),
          },
          buffer,
        });
      }
    } catch {
      // ignore — icon upload is best-effort
    }
  }

  if (pending.length === 0) return [];

  const { uploads } = await client.getAssetUploadUrls(
    pending.map((p) => ({
      asset_type: p.asset.asset_type,
      file_name: p.asset.file_name,
      mime_type: p.asset.mime_type,
    }))
  );

  if (uploads.length !== pending.length) {
    throw new Error(
      `Upload slot count mismatch: requested ${pending.length}, got ${uploads.length}`
    );
  }

  // Parallel upload with concurrency cap of 3.
  const concurrency = 3;
  for (let i = 0; i < pending.length; i += concurrency) {
    const chunk = pending.slice(i, i + concurrency);
    const slots = uploads.slice(i, i + concurrency);
    await Promise.all(
      chunk.map((p, idx) =>
        client.uploadAssetToSignedUrl(
          slots[idx].signed_url,
          p.buffer,
          p.asset.mime_type
        )
      )
    );
  }

  // Return assets with storage refs, no base64.
  return pending.map((p, i) => ({
    asset_type: p.asset.asset_type,
    file_name: uploads[i].file_name,
    mime_type: p.asset.mime_type,
    width: p.asset.width,
    height: p.asset.height,
    source_path: p.asset.source_path,
    storage_bucket: uploads[i].bucket,
    storage_path: uploads[i].storage_path,
  }));
}
