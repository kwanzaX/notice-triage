// Optional LLM refinement on top of the rules, with a hard time budget.
// If the model is slow, fails or returns something off-schema, the rules result stands:
// the notice is never left unassessed because a model misbehaved.

const SCHEMA_KEYS = ['impact', 'summary'];
const IMPACTS = new Set(['low', 'medium', 'high']);

/**
 * @param {object} notice
 * @param {object} rulesResult result of assess()
 * @param {{ complete: (prompt: string, signal: AbortSignal) => Promise<string>, timeoutMs?: number, log?: (e: object) => void }} model
 */
export async function refine(notice, rulesResult, { complete, timeoutMs = 4000, log = () => {} }) {
  const prompt = [
    'You assess the operational impact of an exchange notice on a trading firm.',
    'Reply with JSON only: {"impact":"low|medium|high","summary":"one sentence"}.',
    `Rules already found: impact=${rulesResult.impact}, categories=${rulesResult.categories.join(',') || 'none'}.`,
    'Never lower the impact below what the rules found.',
    `Notice title: ${notice.title}`,
    `Notice body: ${notice.body.slice(0, 6000)}`,
  ].join('\n');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const raw = await complete(prompt, ctrl.signal);
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!SCHEMA_KEYS.every((k) => typeof parsed[k] === 'string') || !IMPACTS.has(parsed.impact)) {
      throw new Error('off-schema reply');
    }
    // The model may raise the impact, never lower it below the rules.
    const order = ['low', 'medium', 'high'];
    const impact = order.indexOf(parsed.impact) > order.indexOf(rulesResult.impact) ? parsed.impact : rulesResult.impact;
    log({ event: 'llm.ok', ms: Date.now() - started });
    return { ...rulesResult, impact, summary: parsed.summary.slice(0, 300), source: 'rules+llm' };
  } catch (err) {
    log({ event: 'llm.fallback', reason: ctrl.signal.aborted ? 'timeout' : err.message, ms: Date.now() - started });
    return rulesResult;
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI-compatible chat completion (works with Groq, OpenAI, local servers). */
export function openAICompatible({ baseUrl, apiKey, model }) {
  return async (prompt, signal) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  };
}
