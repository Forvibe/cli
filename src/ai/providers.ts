import { GoogleGenerativeAI } from "@google/generative-ai";

export interface AIProvider {
  name: string;
  generateJSON(
    systemPrompt: string,
    userPrompt: string,
    temperature: number
  ): Promise<string>;
}

function createGeminiProvider(apiKey: string): AIProvider {
  return {
    name: "Gemini 3.8 Flash",
    async generateJSON(systemPrompt, userPrompt, temperature) {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-3.8-flash",
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
    name: "OpenAI (GPT-5.6 Luna)",
    async generateJSON(systemPrompt, userPrompt, _temperature) {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-5.6-luna",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            reasoning_effort: "low",
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
    name: "Claude (Sonnet 5)",
    async generateJSON(systemPrompt, userPrompt, _temperature) {
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
            model: "claude-sonnet-5",
            max_tokens: 16000,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            output_config: { effort: "medium" },
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

export function getAvailableProviders(): AvailableProvider[] {
  const providers: AvailableProvider[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    providers.push({
      id: "claude",
      name: "Claude (Sonnet 5)",
      recommended: true,
      create: () => createClaudeProvider(anthropicKey),
    });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    providers.push({
      id: "openai",
      name: "OpenAI (GPT-5.6 Luna)",
      recommended: false,
      create: () => createOpenAIProvider(openaiKey),
    });
  }

  const geminiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (geminiKey) {
    providers.push({
      id: "gemini",
      name: "Gemini 3.8 Flash",
      recommended: false,
      create: () => createGeminiProvider(geminiKey),
    });
  }

  return providers;
}
