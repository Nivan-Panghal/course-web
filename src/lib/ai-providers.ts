// src/lib/ai-providers.ts
//
// Text-generation providers for JSON-producing features, with the same order
// the Doubt Assistant (app/api/ai/ask) uses: Gemini first, DeepSeek as the
// fallback. Returns the raw model text (callers parse and validate it) or null
// when every provider failed. Never throws, and never logs prompt contents.
//
// The Doubt Assistant route still has its own copy of the plain-text versions;
// it can switch to this file later.

const GEMINI_MODEL = 'gemini-3.1-flash-lite'

export type GenerateOptions = { maxTokens?: number; temperature?: number }

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function geminiJson(system: string, user: string, opts: GenerateOptions): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('[ai-providers] GEMINI_API_KEY is not set')
    return null
  }
  try {
    const res = await withTimeout(15000, signal =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: user }] }],
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: opts.temperature ?? 0.6,
            maxOutputTokens: opts.maxTokens ?? 2500,
          },
        }),
      })
    )
    if (!res.ok) {
      console.error('[ai-providers] Gemini returned', res.status, (await res.text()).slice(0, 300))
      return null
    }
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('').trim()
    return text || null
  } catch (err: any) {
    console.error('[ai-providers] Gemini failed:', err?.name === 'AbortError' ? 'timed out' : err?.message)
    return null
  }
}

async function deepseekJson(system: string, user: string, opts: GenerateOptions): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    console.error('[ai-providers] DEEPSEEK_API_KEY is not set')
    return null
  }
  try {
    const res = await withTimeout(15000, signal =>
      fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          max_tokens: opts.maxTokens ?? 2500,
          temperature: opts.temperature ?? 0.6,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
    )
    if (!res.ok) {
      console.error('[ai-providers] DeepSeek returned', res.status, (await res.text()).slice(0, 300))
      return null
    }
    const data = await res.json()
    return data?.choices?.[0]?.message?.content?.trim() || null
  } catch (err: any) {
    console.error('[ai-providers] DeepSeek failed:', err?.name === 'AbortError' ? 'timed out' : err?.message)
    return null
  }
}

/** Ask for a JSON answer. The system prompt must describe the JSON shape (DeepSeek's
 *  JSON mode also requires the word "JSON" to appear in the prompt). */
export async function generateJsonText(system: string, user: string, opts: GenerateOptions = {}): Promise<string | null> {
  return (await geminiJson(system, user, opts)) || (await deepseekJson(system, user, opts))
}