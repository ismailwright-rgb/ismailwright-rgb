// What the gap is worth to a CLIENT, per vertical.
//
// These are not our prices. They are the figures a prospect multiplies to work
// out what missed calls already cost them, and they are the whole reason our
// price sounds small — a fee in a vacuum is large, next to a leak it is not.
//
// Defined once, here, because three things consume them and they must agree:
//
//   scripts/emailpages.mjs  prints the worked example on each sell sheet
//   scripts/audit.mjs       must recognise them as client value, not a price,
//                           or it flags every sell sheet as quoting a figure
//                           the catalog does not contain
//   dashboard/src/playbook.js  ECONOMICS, used to build the per-prospect script
//
// The 25% no-timely-response rate is the same one site/index.html's calculator
// uses (v * 0.25 * val), so a prospect who reads a sheet and then plays with
// the calculator sees one story rather than two.
//
// Sources are industry averages and are presented as such on every sheet -
// never as a claim about the reader's own business. A number they re-derive
// with their own two figures is worth more than one we assert.
export const NO_RESPONSE_RATE = 0.25;

export const LEAK = {
  home_services: { calls: 120, value: 600,  unit: 'job',            worth: '$200–$2,000+' },
  law_firm:      { calls: 80,  value: 3500, unit: 'signed case',    worth: '$3,000–$5,000+' },
  medical:       { calls: 200, value: 200,  unit: 'booked patient', worth: '$75–$300, aesthetics higher' },
};

/** Every figure a sell sheet can legitimately print from the table above. */
export function clientValueFigures() {
  const out = new Set();
  for (const l of Object.values(LEAK)) {
    out.add(l.calls);
    out.add(l.value);
    out.add(Math.round(l.calls * NO_RESPONSE_RATE));
    out.add(2 * l.value);                       // "recover even two"
    for (const m of String(l.worth).matchAll(/\$([\d,]+)/g)) {
      out.add(Number(m[1].replace(/,/g, '')));  // the range endpoints
    }
  }
  return out;
}
