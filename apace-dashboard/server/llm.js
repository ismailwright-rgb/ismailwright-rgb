import { config } from './config.js';

/**
 * Asks the model to read the headlines for each candidate and produce the
 * for/against case. It is deliberately NOT given the ability to score or size -
 * it returns sentiment, reasons, and a veto flag, and score.js decides what that
 * is worth.
 */

const SYSTEM_PROMPT = `You are a day-trading research assistant. For each symbol you are given today's computed technical state and any news headlines from the last 36 hours.

Your job is to write the case for and against taking a LONG day trade today, and to flag anything that should stop the trade outright.

Rules:
- Ground every statement in the technicals provided or in a headline you were given. You have no other data.
- Never invent an earnings date, analyst action, price target, or product announcement. If no headlines were supplied for a symbol, say the news picture is unknown and set sentiment to 0.
- Day-trade horizon only: the position opens and closes today. Long-term fundamentals are irrelevant unless they move the stock today.
- Set "veto": true only for a concrete, disqualifying event in the headlines - a halt, an SEC action, a fraud allegation, a pending merger that pins the price, an offering that dilutes, or earnings due today or tomorrow before the position would close.
- Be blunt. If the setup is mediocre, say so in reasons_against.
- Each reason is one short sentence. Two to four reasons per side.

Return only JSON matching this shape:
{"symbols":[{"symbol":"AAPL","sentiment":-1..1,"catalyst":"short phrase or null","reasons_for":["..."],"reasons_against":["..."],"veto":false,"veto_reason":null}]}`;

function buildUserPrompt(candidates) {
  const lines = candidates.map((c) => {
    const headlines = (c.news || []).slice(0, 6);
    const newsBlock = headlines.length
      ? headlines.map((n) => `    - [${n.source}] ${n.headline}`).join('\n')
      : '    - (no headlines in the last 36 hours)';

    return [
      `${c.symbol} @ ${c.last?.toFixed(2) ?? 'n/a'}`,
      `    technical score: ${c.technicalScore}/100`,
      ...c.factors.map((f) => `    ${f.label}: ${f.detail}`),
      '  headlines:',
      newsBlock,
    ].join('\n');
  });

  return `Today is ${new Date().toISOString().slice(0, 10)}.\n\nCandidates:\n\n${lines.join('\n\n')}`;
}

function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : content;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

export async function analyzeNews(candidates) {
  if (!config.openRouterKey) {
    return { available: false, reason: 'OPENROUTER_API_KEY is not set', bySymbol: {} };
  }
  if (!candidates.length) {
    return { available: true, bySymbol: {} };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(candidates) },
        ],
      }),
      // Inside a serverless request the whole analysis shares one short budget,
      // so the model gets a slice of it and the run degrades to technicals-only
      // rather than timing the request out.
      signal: AbortSignal.timeout(config.isServerless ? 7_000 : 90_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { available: false, reason: `OpenRouter ${response.status}: ${detail}`, bySymbol: {} };
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) return { available: false, reason: 'empty model response', bySymbol: {} };

    const parsed = extractJson(content);
    const bySymbol = {};
    for (const entry of parsed.symbols || []) {
      if (!entry?.symbol) continue;
      bySymbol[String(entry.symbol).toUpperCase()] = {
        sentiment: Number(entry.sentiment) || 0,
        catalyst: entry.catalyst || null,
        reasonsFor: Array.isArray(entry.reasons_for) ? entry.reasons_for.slice(0, 4) : [],
        reasonsAgainst: Array.isArray(entry.reasons_against) ? entry.reasons_against.slice(0, 4) : [],
        veto: Boolean(entry.veto),
        vetoReason: entry.veto_reason || null,
      };
    }

    return { available: true, model: config.openRouterModel, bySymbol };
  } catch (error) {
    return { available: false, reason: `model call failed: ${error.message}`, bySymbol: {} };
  }
}
