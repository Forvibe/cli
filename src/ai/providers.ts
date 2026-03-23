import { GoogleGenerativeAI } from "@google/generative-ai";

export interface AIProvider {
  name: string;
  generateJSON(
    systemPrompt: string,
    userPrompt: string,
    temperature: number
  ): Promise<string>;
}

function createGeminiProvider(apiKey: string, deep: boolean): AIProvider {
  const modelId = deep ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
  return {
    name: `Gemini (${deep ? "3.1 Pro" : "3 Flash"})`,
    async generateJSON(systemPrompt, userPrompt, temperature) {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
        },
      });

      const result = await model.generateContent([
        { text: systemPrompt },
        { text: userPrompt },
      ]);

      return result.response.text();
    },
  };
}

function createOpenAIProvider(apiKey: string): AIProvider {
  return {
    name: "OpenAI",
    async generateJSON(systemPrompt, userPrompt, temperature) {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            temperature,
          }),
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `OpenAI API error (${response.status}): ${body.substring(0, 200)}`
        );
      }

      const data = (await response.json()) as {
        choices: { message: { content: string } }[];
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Empty response from OpenAI");
      }

      return content;
    },
  };
}

function createClaudeProvider(apiKey: string): AIProvider {
  return {
    name: "Claude",
    async generateJSON(systemPrompt, userPrompt, temperature) {
      const response = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            temperature,
          }),
        }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Claude API error (${response.status}): ${body.substring(0, 200)}`
        );
      }

      const data = (await response.json()) as {
        content: { type: string; text: string }[];
      };

      const text = data.content?.find((b) => b.type === "text")?.text;
      if (!text) {
        throw new Error("Empty response from Claude");
      }

      return text;
    },
  };
}

export interface AvailableProvider {
  id: string;
  name: string;
  recommended: boolean;
  create: () => AIProvider;
}

export function getAvailableProviders(deep: boolean = false): AvailableProvider[] {
  const providers: AvailableProvider[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push({
      id: "claude",
      name: "Claude",
      recommended: true,
      create: () => createClaudeProvider(anthropicKey),
    });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.push({
      id: "openai",
      name: "OpenAI",
      recommended: false,
      create: () => createOpenAIProvider(openaiKey),
    });
  }

  const geminiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (geminiKey) {
    providers.push({
      id: "gemini",
      name: deep ? "Gemini 3.1 Pro" : "Gemini 3 Flash",
      recommended: false,
      create: () => createGeminiProvider(geminiKey, deep),
    });
  }

  return providers;
}
