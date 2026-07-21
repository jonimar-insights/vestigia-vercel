/**
 * Shared AI client with provider fallback chain.
 * Tries providers in order, falls back on rate limits (429) or errors.
 * All providers use OpenAI-compatible chat/completions API.
 */

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}

interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

const providers: ProviderConfig[] = [
  {
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY || "",
    model: "llama-3.3-70b-versatile",
  },
  {
    name: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: process.env.CLAUDE_API_KEY || "",
    model: "claude-sonnet-4-20250514",
  },
  {
    name: "GPT",
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "gpt-4.1",
  },
  {
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.GEMINI_API_KEY || "",
    model: "gemini-2.0-flash",
  },
  {
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKey: process.env.CEREBRAS_API_KEY || "",
    model: "gemma-4-31b",
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitOrUnavailable(status: number, body: string): boolean {
  if (status === 429 || status === 503 || status === 529) return true;
  if (body.includes("rate_limit") || body.includes("tokens per day")) return true;
  if (body.includes("RESOURCE_EXHAUSTED")) return true;
  if (body.includes("quota") || body.includes("limit exceeded")) return true;
  return false;
}

async function callProvider(
  provider: ProviderConfig,
  options: ChatOptions,
): Promise<{ text: string; provider: string }> {
  let url = `${provider.baseUrl}/chat/completions`;
  let headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: Record<string, unknown>;

  if (provider.name === "Claude") {
    url = `${provider.baseUrl}/messages`;
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = "2023-06-01";

    let systemMsg = "";
    const messages = [];
    for (const m of options.messages) {
      if (m.role === "system") {
        systemMsg = typeof m.content === "string" ? m.content : "";
      } else {
        messages.push({
          role: m.role,
          content: typeof m.content === "string" ? m.content : "",
        });
      }
    }

    body = {
      model: provider.model,
      system: systemMsg || undefined,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    };
  } else {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
    body = {
      model: provider.model,
      stream: false,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? provider.maxTokens ?? 4096,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`${provider.name} HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }

  let text = "";
  try {
    const obj = JSON.parse(raw);
    if (provider.name === "Claude") {
      text = obj.content?.[0]?.text ?? "";
    } else {
      text = obj.choices?.[0]?.message?.content ?? "";
    }
  } catch {
    const lines = raw.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      } catch { /* skip */ }
    }
  }

  return { text, provider: provider.name };
}

/**
 * Call AI with automatic provider fallback.
 * Tries each provider in order. On rate limit/unavailability, falls back to the next.
 * Returns the first successful response.
 */
export async function callAI(options: ChatOptions): Promise<{ text: string; provider: string }> {
  const available = providers.filter((p) => p.apiKey);
  if (available.length === 0) {
    throw new Error("No AI provider configured. Set GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, or OPENROUTER_API_KEY.");
  }

  let lastError: string = "";

  for (let i = 0; i < available.length; i++) {
    const provider = available[i];
    try {
      const result = await callProvider(provider, options);
      if (result.text.trim()) {
        return result;
      }
      lastError = `${provider.name}: empty response`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = isRateLimitOrUnavailable(0, msg) || msg.includes("429") || msg.includes("503") || msg.includes("529");
      lastError = `${provider.name}: ${msg.slice(0, 150)}`;
      console.warn(`AI provider ${provider.name} failed: ${msg.slice(0, 200)}`);

      if (!isRetryable && i < available.length - 1) {
        console.warn(`Non-retryable error, but trying next provider anyway`);
      }

      if (i < available.length - 1) {
        const delay = isRetryable ? 2000 : 500;
        await sleep(delay);
      }
    }
  }

  throw new Error(`All AI providers failed. Last error: ${lastError}`);
}

/**
 * Quick health check — returns the name of the first available provider.
 */
export async function checkAIProvider(): Promise<{ available: boolean; provider: string; error?: string }> {
  const available = providers.filter((p) => p.apiKey);
  if (available.length === 0) {
    return { available: false, provider: "none", error: "No API keys configured" };
  }

  for (const provider of available) {
    try {
      let url = `${provider.baseUrl}/chat/completions`;
      let headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      let body: Record<string, unknown>;

      if (provider.name === "Claude") {
        url = `${provider.baseUrl}/messages`;
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
        body = {
          model: provider.model,
          messages: [{ role: "user", content: "Say OK" }],
          max_tokens: 5,
        };
      } else {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
        body = {
          model: provider.model,
          messages: [{ role: "user", content: "Say OK" }],
          max_tokens: 5,
        };
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (res.ok) {
        return { available: true, provider: provider.name };
      }
      const errText = await res.text();
      if (isRateLimitOrUnavailable(res.status, errText)) {
        continue; // try next provider
      }
    } catch {
      continue;
    }
  }

  return { available: false, provider: "none", error: "All providers failed health check" };
}

export { providers };
