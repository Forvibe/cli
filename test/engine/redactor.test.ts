import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../../src/engine/redactor.js";
import { fixturePath } from "../helpers/fixture-path.js";

describe("redactSecrets", () => {
  describe("one positive case per kind", () => {
    it("pem: redacts an entire private-key block as one match", () => {
      const source = [
        "before",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEr2t2gz5uJ8dNI7YvW2vaOG7BFCUJU",
        "xoWkjF5nDIQzYlZ3IlSuThfw9AAmiRUZ9eUCAwEAAQ==",
        "-----END RSA PRIVATE KEY-----",
        "after",
      ].join("\n");

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("before\n[REDACTED:pem]\nafter");
    });

    it("pem: also matches a bare 'PRIVATE KEY' block with no algorithm prefix", () => {
      const source = "-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----";

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("[REDACTED:pem]");
    });

    it("anthropic: redacts an sk-ant- key", () => {
      const source = 'const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('const key = "[REDACTED:anthropic]";');
    });

    it("openai: redacts an sk-proj- key", () => {
      const source = 'OPENAI_KEY="sk-proj-ABCDEFGHIJKLMNOPQRST1234"';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('OPENAI_KEY="[REDACTED:openai]"');
    });

    it("openai: redacts a bare sk-<32+ alnum> key", () => {
      const bareKey = `sk-${"A".repeat(32)}`;
      const source = `OPENAI_KEY="${bareKey}"`;

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('OPENAI_KEY="[REDACTED:openai]"');
    });

    it("stripe: redacts an sk_live_ key", () => {
      const source = 'stripeKey = "sk_live_ABCDEFGHIJKLMNOPQRST1234"';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('stripeKey = "[REDACTED:stripe]"');
    });

    it("google: redacts an AIza... key (exactly 35 trailing chars)", () => {
      const googleKey = `AIza${"A".repeat(35)}`;
      const source = `const key = "${googleKey}";`;

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('const key = "[REDACTED:google]";');
    });

    it("aws: redacts an AKIA... access key id (exactly 16 trailing chars)", () => {
      const awsKey = `AKIA${"B".repeat(16)}`;
      const source = `aws_access_key_id = ${awsKey}`;

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("aws_access_key_id = [REDACTED:aws]");
    });

    it("github: redacts a ghp_ personal access token", () => {
      const ghToken = `ghp_${"C".repeat(20)}`;
      const source = `GITHUB_TOKEN=${ghToken}`;

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("GITHUB_TOKEN=[REDACTED:github]");
    });

    it("slack: redacts an xoxb- bot token", () => {
      const source = "SLACK_TOKEN=xoxb-1234567890-abcdefghij";

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("SLACK_TOKEN=[REDACTED:slack]");
    });

    it("jwt: redacts a three-segment eyJ...eyJ...sig token", () => {
      const jwt = `eyJ${"A".repeat(10)}.eyJ${"B".repeat(10)}.${"C".repeat(10)}`;
      const source = `Authorization: Bearer ${jwt}`;

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe("Authorization: Bearer [REDACTED:jwt]");
    });

    it("generic: redacts a quoted 12+ char value assigned to a recognized key name (equals delimiter)", () => {
      const source = 'const clientSecret = "abcdefghijklmnopqrstuvwxyz";';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('const clientSecret = "[REDACTED:generic]";');
    });

    it("generic: also matches a colon delimiter (YAML/config style)", () => {
      const source = 'api_key: "abcdefghijklmnopqrst"';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('api_key: "[REDACTED:generic]"');
    });

    it("generic: key-name matching is case-insensitive", () => {
      const source = 'PASSWORD = "abcdefghijklmnopqrst"';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(1);
      expect(result.text).toBe('PASSWORD = "[REDACTED:generic]"');
    });
  });

  describe("guardrails", () => {
    it("does not trigger on identifiers that merely start with a key name (tokenizer, secretSanta)", () => {
      const source = 'const tokenizer = new Tokenizer();\nlet secretSanta = "myFriendIsBob123";';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(0);
      expect(result.text).toBe(source);
    });

    it("does not redact a quoted value shorter than 12 characters", () => {
      const source = 'const apiKey = "short1";';

      const result = redactSecrets(source);

      expect(result.redactedCount).toBe(0);
      expect(result.text).toBe(source);
    });

    it("is idempotent: redacting already-redacted text adds zero further redactions and leaves the text byte-identical", () => {
      const source =
        'let apiKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\n' +
        'const token = "plainLongLivedValue1234";';

      const first = redactSecrets(source);
      expect(first.redactedCount).toBe(2); // one anthropic + one generic (the "token" line)

      const second = redactSecrets(first.text);

      expect(second.redactedCount).toBe(0);
      expect(second.text).toBe(first.text);
    });

    it("running redactSecrets a third time still adds nothing (idempotency holds beyond just the second call)", () => {
      const source = 'apiKey = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"';

      const once = redactSecrets(source);
      const twice = redactSecrets(once.text);
      const thrice = redactSecrets(twice.text);

      expect(thrice.redactedCount).toBe(0);
      expect(thrice.text).toBe(once.text);
    });
  });

  it("value-only replacement: the generic rule preserves the key name, delimiter, and quote characters exactly", () => {
    const source = '   secret:   \'abcdefghijklmnopqrstuvwxyz\'   ';

    const result = redactSecrets(source);

    expect(result.redactedCount).toBe(1);
    expect(result.text).toBe("   secret:   '[REDACTED:generic]'   ");
  });

  it("swift-app fixture: AppDelegate.swift redacts exactly the one planted anthropic key, and the rest of the line survives", () => {
    const appDelegatePath = join(fixturePath("swift-app"), "MyApp", "AppDelegate.swift");
    const content = readFileSync(appDelegatePath, "utf-8");

    const result = redactSecrets(content);

    expect(result.redactedCount).toBe(1);
    expect(result.text).toContain('let apiKey = "[REDACTED:anthropic]"');
    expect(result.text).not.toContain("sk-ant-");
    // The rest of the file is untouched.
    expect(result.text).toContain("import UIKit");
    expect(result.text).toContain("import StoreKit");
    expect(result.text).toContain("func createAccount(email: String) {");
    expect(result.text).toContain('print("Creating account for \\(email)")');
  });
});
