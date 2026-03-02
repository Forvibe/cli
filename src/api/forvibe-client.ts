import type { CLIProjectReport } from "../types/report.js";

const DEFAULT_API_URL = "https://forvibe.app";

interface ValidateOTCResponse {
  session_id: string;
  session_token: string;
}

interface SubmitReportResponse {
  success: boolean;
  web_url: string;
}

/**
 * Fetch wrapper that follows redirects while preserving the Authorization header.
 * The standard Fetch API strips Authorization on cross-origin redirects
 * (e.g. forvibe.app → www.forvibe.app), so we handle redirects manually.
 */
async function fetchWithAuth(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
  maxRedirects = 3
): Promise<Response> {
  let currentUrl = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });

    // Not a redirect — return as-is
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // Follow redirect with original headers intact
    const location = response.headers.get("location");
    if (!location) return response;

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error("Too many redirects");
}

export class ForvibeClient {
  private baseUrl: string;
  private sessionToken: string | null = null;
  public sessionId: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.FORVIBE_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  }

  /**
   * Validate OTC code and get session token
   */
  async validateOTC(code: string): Promise<ValidateOTCResponse> {
    const normalizedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, "");

    const response = await fetch(`${this.baseUrl}/api/agent/validate-otc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: normalizedCode }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));

      if (response.status === 429) {
        throw new Error("Too many attempts. Please wait a moment and try again.");
      }
      if (response.status === 410) {
        throw new Error("Connection code has expired. Please generate a new one on forvibe.app.");
      }
      if (response.status === 404) {
        throw new Error("Invalid connection code. Please check and try again.");
      }

      throw new Error(error.error || `Validation failed (${response.status})`);
    }

    const data = (await response.json()) as ValidateOTCResponse;
    this.sessionToken = data.session_token;
    this.sessionId = data.session_id;
    return data;
  }

  /**
   * Submit the CLI project report
   */
  async submitReport(report: CLIProjectReport): Promise<SubmitReportResponse> {
    if (!this.sessionToken) {
      throw new Error("Not connected. Please validate OTC code first.");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.sessionToken}`,
    };

    const response = await fetchWithAuth(`${this.baseUrl}/api/agent/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({ report }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      let errorMessage: string | undefined;
      try {
        const errorJson = JSON.parse(bodyText);
        errorMessage = errorJson.error;
      } catch {
        // Response is not JSON (e.g., HTML error page)
      }

      if (response.status === 401) {
        throw new Error(
          errorMessage || "Session expired. Please generate a new connection code."
        );
      }
      if (response.status === 409) {
        throw new Error(
          errorMessage || "Report has already been submitted for this session."
        );
      }
      if (response.status === 413) {
        throw new Error("Report too large. Try reducing the number of screenshots.");
      }

      throw new Error(
        errorMessage || `Report submission failed (HTTP ${response.status}: ${bodyText.substring(0, 200)})`
      );
    }

    return (await response.json()) as SubmitReportResponse;
  }
}
