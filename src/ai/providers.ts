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
    name: "Gemini",
    async generateJSON(systemPrompt, userPrompt, temperature) {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
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

export function detectProvider(): AIProvider {
  const geminiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (geminiKey) return createGeminiProvider(geminiKey);

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return createOpenAIProvider(openaiKey);

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) return createClaudeProvider(anthropicKey);

  throw new Error("NO_API_KEY");
}
