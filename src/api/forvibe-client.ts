import type {
  CLIProjectReport,
  TechStackResult,
  ParsedConfig,
  SDKScanResult,
  BrandingResult,
} from "../types/report.js";

const DEFAULT_API_URL = "https://forvibe.app";

interface ValidateOTCResponse {
  session_id: string;
  session_token: string;
}

interface SubmitReportResponse {
  success: boolean;
  web_url: string;
}

export interface AnalyzeProjectInput {
  techStack: TechStackResult;
  config: ParsedConfig;
  sdkScan: SDKScanResult;
  branding: BrandingResult;
  readmeContent: string | null;
  sourceCode: string;
  projectTree: string | null;
}

interface AnalyzeResponse {
  report: CLIProjectReport;
  warnings?: string[];
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

  /**
   * Send raw project data to backend for AI analysis (Gemini proxy)
   */
  async analyzeProject(input: AnalyzeProjectInput): Promise<AnalyzeResponse> {
    if (!this.sessionToken) {
      throw new Error("Not connected. Please validate OTC code first.");
    }

    const response = await fetch(`${this.baseUrl}/api/agent/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify({
        tech_stack: {
          stack: input.techStack.stack,
          label: input.techStack.label,
          platforms: input.techStack.platforms,
          configFiles: input.techStack.configFiles,
        },
        config: {
          app_name: input.config.app_name,
          bundle_id: input.config.bundle_id,
          version: input.config.version,
          min_ios_version: input.config.min_ios_version,
          min_android_sdk: input.config.min_android_sdk,
          description: input.config.description,
        },
        sdk_scan: {
          detected_sdks: input.sdkScan.detected_sdks,
          data_collected: input.sdkScan.data_collected,
          advertising_type: input.sdkScan.advertising_type,
          third_party_services: input.sdkScan.third_party_services,
          has_iap: input.sdkScan.has_iap,
        },
        branding: {
          primary_color: input.branding.primary_color,
          secondary_color: input.branding.secondary_color,
          app_icon_base64: input.branding.app_icon_base64,
        },
        readme_content: input.readmeContent,
        source_code: input.sourceCode,
        project_tree: input.projectTree,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));

      if (response.status === 401) {
        throw new Error("Session expired. Please generate a new connection code.");
      }

      throw new Error(error.error || `Analysis failed (${response.status})`);
    }

    return (await response.json()) as AnalyzeResponse;
  }
}
