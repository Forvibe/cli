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

    const response = await fetch(`${this.baseUrl}/api/agent/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({ report }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));

      if (response.status === 401) {
        throw new Error("Session expired. Please generate a new connection code.");
      }
      if (response.status === 409) {
        throw new Error("Report has already been submitted for this session.");
      }

      throw new Error(error.error || `Report submission failed (${response.status})`);
    }

    return (await response.json()) as SubmitReportResponse;
  }
}
