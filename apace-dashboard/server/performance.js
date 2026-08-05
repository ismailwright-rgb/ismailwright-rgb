import { readOutcomes } from './exits.js';

/**
 * What the trade history actually says.
 *
 * The appealing version of "give it memory" is to hand past trades back to the
 * model and hope it reasons better. It does not: a language model shown its own
 * history will produce a plausible story about it either way. What genuinely
 * improves the system is measuring which factors were pointing the right way
 * when trades worked, and re-weighting from that.
 *
 * So this reports, per factor, the average outcome of trades taken when that
 * factor was strongly positive versus when it was not. A factor that carries
 * weight but shows no separation is weight being wasted.
 *
 * It needs a real sample. Under about 30 closed trades the numbers are noise,
 * and the report says so rather than letting them look meaningful.
 */

const MEANINGFUL_SAMPLE = 30;
const STRONG = 0.4; // a factor is "on" above this strength

function summarise(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, avgR: 0, totalR: 0 };
  const totalR = trades.reduce((sum, t) => sum + t.r, 0);
  return {
    trades: trades.length,
    winRate: Number(((trades.filter((t) => t.win).length / trades.length) * 100).toFixed(1)),
    avgR: Number((totalR / trades.length).toFixed(3)),
    totalR: Number(totalR.toFixed(2)),
  };
}

export async function performance() {
  const outcomes = await readOutcomes();

  const overall = summarise(outcomes);
  const sufficient = outcomes.length >= MEANINGFUL_SAMPLE;

  /* --- per factor --------------------------------------------------------- */
  const factorKeys = new Set();
  for (const trade of outcomes) for (const f of trade.factors || []) factorKeys.add(f.key);

  const byFactor = [...factorKeys]
    .map((key) => {
      const on = outcomes.filter((t) => (t.factors || []).some((f) => f.key === key && f.strength >= STRONG));
      const off = outcomes.filter((t) => (t.factors || []).some((f) => f.key === key && f.strength < STRONG));
      const separation = on.length && off.length ? summarise(on).avgR - summarise(off).avgR : null;
      return {
        factor: key,
        whenStrong: summarise(on),
        whenWeak: summarise(off),
        // Positive means trades did better when this factor was firing.
        separation: separation === null ? null : Number(separation.toFixed(3)),
      };
    })
    .sort((a, b) => (b.separation ?? -Infinity) - (a.separation ?? -Infinity));

  /* --- per score band ----------------------------------------------------- */
  const bands = [
    { label: '90+', min: 90 },
    { label: '80-89', min: 80 },
    { label: '75-79', min: 75 },
    { label: 'under 75', min: 0 },
  ];
  const byScore = bands.map(({ label, min }, i) => {
    const max = i === 0 ? Infinity : bands[i - 1].min;
    return { band: label, ...summarise(outcomes.filter((t) => t.score >= min && t.score < max)) };
  });

  const group = (key) => {
    const values = [...new Set(outcomes.map((t) => t[key]).filter(Boolean))];
    return values.map((value) => ({ [key]: value, ...summarise(outcomes.filter((t) => t[key] === value)) }))
      .sort((a, b) => b.totalR - a.totalR);
  };

  const notes = [];
  if (!sufficient) {
    notes.push(
      `${outcomes.length} closed trades. Below about ${MEANINGFUL_SAMPLE} these numbers are noise - a run of ` +
        'three winners says nothing. Treat this as a record, not a finding, until the sample grows.',
    );
  }
  if (sufficient) {
    const best = byFactor[0];
    const worst = byFactor[byFactor.length - 1];
    if (best?.separation > 0.2) {
      notes.push(`${best.factor} separates most: ${best.separation}R better when it is firing.`);
    }
    if (worst?.separation !== null && worst?.separation < 0) {
      notes.push(
        `${worst.factor} is inverted - trades did ${Math.abs(worst.separation)}R WORSE when it fired. ` +
          'If that holds up, its weight is working against you.',
      );
    }
  }

  return {
    at: new Date().toISOString(),
    sufficientSample: sufficient,
    minimumSample: MEANINGFUL_SAMPLE,
    overall,
    byScore,
    byFactor,
    bySymbol: group('symbol').slice(0, 15),
    byWindow: group('window'),
    notes,
    recent: outcomes.slice(0, 20),
  };
}
