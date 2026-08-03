// What the gap is worth to a CLIENT, per vertical.
//
// These are not our prices. They are the figures a prospect multiplies to work
// out what missed calls already cost them, and they are the whole reason our
// price sounds small — a fee in a vacuum is large, next to a leak it is not.
//
// Defined once, here, because several things consume them and they must agree:
//
//   scripts/emailpages.mjs  prints the leak table and the stat row on each sheet
//   scripts/audit.mjs       must recognise them as client value, not a price,
//                           or it flags every sell sheet as quoting a figure
//                           the catalog does not contain
//   site/leak-audit.html    the interactive version, and the leak-audit PDF
//   dashboard/src/playbook.js  ECONOMICS, used to build the per-prospect script
//
// The bands are lifted verbatim from site/leak-audit.html so the sheet, the
// calculator and the PDF a prospect may already have all tell one story.
//
// Assumptions, stated on every sheet rather than buried: 25% of leads never get
// a real response, and 35% of the ones you do reach close. Both are cautious —
// service businesses miss 25-40% of calls in business hours and 60%+ after,
// and small businesses answer only 37.8% of calls overall.
export const NO_RESPONSE_RATE = 0.25;
export const CLOSE_RATE = 0.35;

export const LEAK = {
  home_services: {
    industry: 'HVAC / Home Services',
    leads: [60, 90], value: [1200, 2000], losing: [6300, 15750],
    unit: 'job',
  },
  law_firm: {
    industry: 'Personal Injury Law',
    leads: [80, 120], value: [3500, 5000], losing: [24500, 52500],
    unit: 'signed case',
  },
  medical: {
    industry: 'Dental / Medical',
    leads: [45, 65], value: [800, 1200], losing: [3150, 6825],
    unit: 'booked patient',
  },
};

/** Every figure a sell sheet can legitimately print from the table above. */
export function clientValueFigures() {
  const out = new Set();
  for (const l of Object.values(LEAK)) {
    for (const arr of [l.leads, l.value, l.losing]) for (const n of arr) out.add(n);
    // the mid-band figures the stat row derives
    const midLose = Math.round((l.losing[0] + l.losing[1]) / 2);
    const midLeads = Math.round((l.leads[0] + l.leads[1]) / 2);
    out.add(midLose);
    out.add(midLose * 12);
    out.add(Math.round(midLose * 0.4));
    out.add(Math.round(midLose * 0.4) * 12);
    out.add(midLeads);
    out.add(Math.round(midLeads * NO_RESPONSE_RATE));
    out.add(midLeads - Math.round(midLeads * NO_RESPONSE_RATE));
  }
  return out;
}
