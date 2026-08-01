// ============================================================================
// Playbook: turn a scraped prospect into (a) the workflow they'd benefit from
// most and (b) a call script that uses their own evidence.
//
// Pure functions over the `signals` blob W1 already stores - no extra API
// calls, no scraper changes.
// ============================================================================

export const WORKFLOWS = {
  missed_call: {
    name: 'Missed-Call Text-Back',
    tag: 'Flagship',
    blurb: 'Unanswered call triggers an instant text from their number: "Sorry we missed you — what do you need help with?"',
  },
  after_hours: {
    name: 'After-Hours Intake',
    tag: 'Capture',
    blurb: 'Form/chat that qualifies with three questions, then books or escalates urgent work.',
  },
  nurture: {
    name: 'Lead Nurture',
    tag: 'Convert',
    blurb: 'Five-touch follow-up for everyone who inquired and went quiet.',
  },
  reminders: {
    name: 'Reminders & No-Show Recovery',
    tag: 'Retain',
    blurb: 'Confirmations, 24h/1h reminders, and an automatic rebook offer the morning after a no-show.',
  },
  reviews: {
    name: 'Review Engine',
    tag: 'Grow',
    blurb: 'Post-service review request from their name, timed to when the customer is happiest.',
  },
  custom: {
    name: 'Custom Build',
    tag: 'Custom',
    blurb: 'They have the basics — the win is in a specific broken handoff. Scope it on the call.',
  },
};

// What one lost lead is worth, by vertical (from the Sanaku brief).
export const ECONOMICS = {
  law_firm: { one: 3500, label: 'one signed case', range: '$3,000–$5,000+' },
  medical: { one: 200, label: 'one booked patient', range: '$75–$300 (aesthetics higher)' },
  home_services: { one: 600, label: 'one job', range: '$200–$2,000+' },
};

const has = (p, cat) => Boolean(p.signals?.detected?.[cat]?.length);

/**
 * Pick the workflow this business would benefit from most, with the reason
 * stated in terms of what we actually observed on their site.
 */
export function recommendWorkflow(p) {
  const s = p.signals || {};
  const chat = has(p, 'chat') || has(p, 'ai_voice');
  const booking = has(p, 'booking');
  const crm = has(p, 'crm');
  const ads = has(p, 'ads');
  const reviews = s.review_count ?? 0;
  const rating = s.rating ?? 0;

  if (s.fetch_failed) {
    return {
      key: 'missed_call',
      confidence: 'unverified',
      why: 'Their site blocked our scan, so this is the safe default — check the site by hand before the call.',
      secondary: null,
    };
  }

  // Nobody catching the phone is always the biggest hole, and the easiest sell.
  if (!chat && !booking) {
    return {
      key: 'missed_call',
      confidence: 'high',
      why: ads
        ? 'They pay for ads but have no chat widget and no booking tool — they are buying calls they cannot catch.'
        : 'No chat widget and no booking tool. Every call that rings out is simply gone.',
      secondary: s.has_contact_form ? 'after_hours' : null,
    };
  }

  // Booking exists but nothing catches the phone or the after-hours web visitor.
  if (booking && !chat) {
    if (p.vertical === 'medical') {
      return {
        key: 'reminders',
        confidence: 'high',
        why: `They already book online (${s.detected.booking.join(', ')}), so the money is leaking at no-shows and unconfirmed appointments, not at capture.`,
        secondary: 'missed_call',
      };
    }
    return {
      key: 'missed_call',
      confidence: 'high',
      why: `They have booking (${s.detected.booking.join(', ')}) but nothing catching the phone — booking tools do not answer calls.`,
      secondary: 'after_hours',
    };
  }

  // Chat present but no follow-up machinery: leads land and go cold.
  if (chat && !crm) {
    return {
      key: 'nurture',
      confidence: 'medium',
      why: `They capture leads (${s.detected.chat.join(', ')}) but have no CRM or email tooling — captured leads get one touch and die.`,
      secondary: 'reviews',
    };
  }

  // Thin review presence is a standalone, easy-to-prove win.
  if (reviews < 25 || (rating && rating < 4.3)) {
    return {
      key: 'reviews',
      confidence: 'medium',
      why: `Only ${reviews || 'a handful of'} Google reviews${rating ? ` at ${rating}` : ''} — reviews drive the calls every other workflow depends on.`,
      secondary: 'missed_call',
    };
  }

  return {
    key: 'custom',
    confidence: 'low',
    why: 'They already run chat, booking, and a CRM. Deprioritize — or find the one broken handoff on a discovery call.',
    secondary: 'nurture',
  };
}

const firstName = (full) => (full || '').trim().split(/\s+/)[0] || '';

/**
 * Build a call script for this specific prospect. The frame is always loss,
 * never features: get them to state the problem in their own words.
 */
export function buildScript(p, rec) {
  const s = p.signals || {};
  const econ = ECONOMICS[p.vertical] || ECONOMICS.home_services;
  const wf = WORKFLOWS[rec.key];
  const who = firstName(p.contact_name);
  const greeting = who ? `Hi ${who}, ` : 'Hi, ';
  const ads = has(p, 'ads');

  const observation =
    s.fetch_failed
      ? `I was looking at ${p.company_name} online`
      : ads
      ? `I noticed ${p.company_name} is running ads`
      : s.review_count
      ? `I saw ${p.company_name} has ${s.review_count} reviews at ${s.rating}`
      : `I was looking at ${p.company_name}'s site`;

  const QUESTIONS = {
    law_firm:
      'When someone calls after 6pm — an accident victim who is calling three firms in a row — where does that call go?',
    medical:
      'When someone calls to book and gets voicemail at lunch, does anyone track how many of those call back?',
    home_services:
      'When your techs are on a job and the phone rings, where does that call go?',
  };

  const STAKES = {
    law_firm:
      'Accident victims call three or four firms in the first hour. Whoever answers first usually signs the case.',
    medical:
      'Most patients who hit voicemail do not call back — they just book with the next practice on Google.',
    home_services:
      'Emergency work goes to whoever picks up. The next shop on the list gets the job you paid to advertise for.',
  };

  return {
    opener: `${greeting}${observation} — I help ${
      p.vertical === 'law_firm' ? 'firms' : p.vertical === 'medical' ? 'practices' : 'shops'
    } like yours stop losing calls they already paid for. Can I ask you one quick question and then get out of your way?`,
    question: QUESTIONS[p.vertical] || QUESTIONS.home_services,
    stakes: STAKES[p.vertical] || STAKES.home_services,
    evidence: rec.why,
    math: `Ask them two numbers: how many calls/inquiries a month, and what ${econ.label} is worth (typically ${econ.range}). Multiply by 25% missed. Say the result out loud — that is the pitch.`,
    solution: `${wf.name}: ${wf.blurb}`,
    close:
      'Would it be worth 15 minutes to see exactly where those are going? I can show you the number on a screen share.',
    objections: [
      {
        q: '"We already have someone answering the phone."',
        a: 'Right — and when they are on the other line, at lunch, or it is 7pm? This only fires when nobody picks up. It costs you nothing when your team catches it.',
      },
      {
        q: '"We are too busy / not interested."',
        a: 'Fair enough. Out of curiosity — do you know how many calls went unanswered last week? Most owners do not, and that is the part that surprises people.',
      },
      {
        q: '"How much is it?"',
        a: `Depends on volume, but it is a flat monthly fee — small next to ${econ.label} at ${econ.range}. If it does not catch more than it costs, cancel it.`,
      },
    ],
  };
}

/** Flatten a script into copy-paste text for notes or a CRM. */
export function scriptToText(p, rec, sc) {
  return [
    `${p.company_name} — ${p.contact_phone || 'no phone'} — ${p.website_url || p.domain}`,
    `Best fit: ${WORKFLOWS[rec.key].name} (${rec.confidence} confidence)`,
    `Why: ${rec.why}`,
    '',
    `OPEN: ${sc.opener}`,
    `ASK: ${sc.question}`,
    `STAKES: ${sc.stakes}`,
    `MATH: ${sc.math}`,
    `OFFER: ${sc.solution}`,
    `CLOSE: ${sc.close}`,
    '',
    'OBJECTIONS:',
    ...sc.objections.map((o) => `  ${o.q}\n    -> ${o.a}`),
  ].join('\n');
}
