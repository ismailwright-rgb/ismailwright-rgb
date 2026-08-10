-- ============================================================================
-- Seed - the cold outreach brief
--
-- W2's Build Prompt currently hardcodes the voice: a system message plus a
-- per-vertical example line, edited in a Code node inside a workflow JSON. That
-- makes the voice invisible (you have to open n8n to read it), unversioned
-- against the brand, and impossible to change without a redeploy.
--
-- These rows move it where the LinkedIn voice already lives. Same table, same
-- pattern, different channel. Change the copy by editing a row.
--
-- NOTE ON THE VERTICAL VALUE. brand_brain.vertical is the ENUM public.vertical,
-- whose PI value is 'personal_injury_law'. sanaku_prospects.vertical is a TEXT
-- column whose PI value is 'law_firm'. They are the same audience under two
-- names - a divergence flagged in migration 022 and still not unified, because
-- unifying it means rewriting W1's output and backfilling live rows.
--
-- The consequence for W2: the prompt builder MUST map the prospect's vertical
-- to the brain's before it selects rows, or a law firm silently gets no ICP
-- section and the email is written with no idea who it is going to. Only PI
-- differs; accounting_tax, therapy, financial_advisory and family_office are
-- spelled identically in both.
--
-- channel = 'email' throughout, so nothing here leaks into the LinkedIn studio
-- (which filters channel = 'linkedin') and nothing there leaks into cold email.
-- The rows with channel NULL - the original positioning, the compliance rule,
-- the targeting rule - apply to both and are untouched.
--
-- RUN AFTER migration-025. Safe to run more than once - it clears the email
-- channel first.
-- ============================================================================

delete from public.brand_brain where channel = 'email' and title <> 'How Sanaku talks';

insert into public.brand_brain (kind, title, content, vertical, channel, status) values

-- ----------------------------------------------------------------------------
-- The shape of every touch
-- ----------------------------------------------------------------------------
('rule', 'Cold email - the shape',
$t$PAIN FIRST, THEN THE FIX. Never open with who I am or what Sanaku does. Open with the exposure they already carry, in their own terms. The solution is one sentence near the end.

Length: 90-130 words. Anything longer does not get read on a phone between meetings.

Exactly ONE ask, and it is always the same: a short call. Never "let me know your thoughts", never two questions, never a link to book AND a question - that is two asks and it halves the reply rate.

Plain text. No HTML, no images, no tracking pixel, no logo. A cold message from a new domain that arrives looking like a newsletter gets filtered like one.

First person, as Ismail. Short sentences. No em-dashes stacked into asides. Contractions are fine. Never "I hope this finds you well", never "I wanted to reach out", never "quick question" as an opener - all three are dead giveaways of a template.

Never explain how the system is built. No model names, no architecture, no stack. They are not buying a build.

Sign off with a real name and a real sending identity. Every message carries a working way to opt out.$t$,
null, 'email', 'proven'),

('rule', 'Cold email - the hook',
$t$The hook is the risk they are already carrying without having decided to carry it.

The specific version, which is true and almost never top of mind: their own staff are pasting client information into public AI tools right now. Not maliciously - a paralegal summarising a medical record at 7pm, a bookkeeper cleaning a client ledger in January. The firm has no policy that covers it and no log of it having happened.

That is the opening. It is uncomfortable, it is concrete, and it is not a pitch.

Then, and only then: I build AI that runs inside the firm's own building, so the work still gets done and the file never leaves the network.

Do NOT lead with efficiency, productivity, hours saved, or "leveraging AI". Every one of those emails is already in their inbox this morning.$t$,
null, 'email', 'proven'),

('rule', 'Cold email - the one ask',
$t$The goal of every touch is a short discovery call. Nothing else.

Not a demo. Not a whitepaper. Not a "quick 15 minutes to learn about your business" - that reads as a sales call and is declined as one. Ask for a short call about the specific thing the email just raised.

Phrase the ask as a question they can answer yes or no to in one word. "Worth a short call?" beats "Let me know if you would like to schedule some time to discuss."

On the first touch, a link may be offered as proof - the architecture one-pager or a Featured post. Link, never attach; an attachment from an unknown sender is a spam signal. Offering the link is not a second ask, as long as the call remains the only thing being requested.$t$,
null, 'email', 'proven'),

-- ----------------------------------------------------------------------------
-- The three touches
-- ----------------------------------------------------------------------------
('rule', 'Cold email - the sequence',
$t$Three touches, then stop. A fourth is harassment and gets marked as spam.

TOUCH 1, opener. The risk, named specifically for their profession, then the one-line fix, then the ask. This is the only touch that may include a proof link.

TOUCH 2, day 3, no reply. A DIFFERENT angle, not a nudge. Never "just following up", never "bumping this", never "did you see my last email" - those say only that I want something. Take a second true thing about their exposure and lead with that instead. Shorter than the opener.

TOUCH 3, day 8, breakup. Two or three sentences. Say plainly that I will stop, and leave the door open without asking for anything. No guilt, no false scarcity, no "I'll assume you're not interested". A good breakup gets replies precisely because it asks for nothing.$t$,
null, 'email', 'proven'),

-- ----------------------------------------------------------------------------
-- Per-vertical: what confidentiality means to THEM
-- ----------------------------------------------------------------------------
('icp', 'Cold email - personal injury law',
$t$What they carry: attorney-client privilege, the duty of confidentiality, and a medical record in nearly every open file.

The exposure to name: a public AI tool that has seen a client's medical history has arguably received a disclosure, and state bar guidance on exactly this is arriving now and getting stricter. A firm cannot say it did not happen if it has no log either way.

Their words: intake, case, client, the file, records, demand letter, privilege. Never "leads", never "customers", never "tickets".

Who is reading: an owner, managing partner or COO. They are not technical and do not want to be. They will decide on exposure, not features.$t$,
'personal_injury_law', 'email', 'proven'),

('icp', 'Cold email - accounting and tax',
$t$What they carry: SSNs, complete financial pictures, business books, and Circular 230 obligations. One folder holds a client's entire financial life.

The exposure to name: staff pasting returns or ledgers into public AI during busy season, when the pressure is highest and the judgement worst. The IRS Office of Professional Responsibility has now issued AI guidance, and the duty is about custody of client information, not about which tool was used.

Their words: clients, engagement, return, books, close, busy season. Never "cases".

Timing: between January and April they are unreachable and resent being contacted. Outside that window they will actually think about this.$t$,
'accounting_tax', 'email', 'proven'),

('icp', 'Cold email - therapy and counseling',
$t$Handle with the most care of the five. The confidentiality here is clinical, and a breach is a harm to a patient rather than an inconvenience to a business.

What they carry: HIPAA, session notes, and a duty of confidence that is load-bearing for whether the therapy works at all.

The exposure to name: AI transcription and note-taking tools that process session content on somebody else's servers. A BAA assigns liability after a breach; it is not a wall that prevents one. Most practitioners have not been told the difference.

Their words: clients or patients, sessions, notes, practice, intake. Never "leads".

Tone: quieter than the other verticals. No urgency, no loss framing, nothing that reads as leveraging a patient's distress. Often a solo practitioner who is also the receptionist and the biller.$t$,
'therapy', 'email', 'proven'),

('icp', 'Cold email - financial advisors and wealth managers',
$t$What they carry: SEC and FINRA obligations, Reg S-P, books-and-records and communications-archiving rules, and a complete picture of a client's wealth.

The exposure to name: an AI tool may create a record they are required to retain and produce, held somewhere they cannot produce it from. Client data sitting with a vendor is a Reg S-P question, not an IT question.

Their words: clients, accounts, AUM, compliance, the CCO, suitability.

Expect the compliance question immediately - that is engagement, not an objection. Often the Chief Compliance Officer is the real reader even when the email is addressed to a principal.$t$,
'financial_advisory', 'email', 'proven'),

('icp', 'Cold email - family offices',
$t$Smallest audience, highest sensitivity, longest cycle. Write for them rarely and never write down to them.

What they carry: personal and family information well beyond financials, and principals who will ask directly where something runs.

The exposure to name: any third party holding the family's information at all. Not a compliance framing - a discretion framing. Discretion is the product.

Their words: the family, the principals, the office. Never "customers", never "growth", never "scale".

Tone: quiet and understated. No urgency, no scarcity, no metrics. The shortest email of the five.$t$,
'family_office', 'email', 'proven'),

-- ----------------------------------------------------------------------------
-- Subject lines and deliverability
-- ----------------------------------------------------------------------------
('rule', 'Cold email - subject lines',
$t$Specific and plain. It should read like a note from someone who knows the profession, not a campaign.

Lowercase or sentence case. Three to seven words. No colons splitting a clever phrase, no brackets, no emoji, no personalisation token that will misfire.

Never use: free, guarantee, act now, limited time, urgent, opportunity, revolutionary, unlock, boost, 10x, ROI, AI-powered. Several are spam-filter triggers and all of them read as bulk.

Never fake a relationship: no "re:" on a first email, no "following up on our conversation" when there was none. It gets one open and destroys the only thing being sold, which is trustworthiness about data.

Good shape: name the thing they have not considered. "where your client files actually go", "the AI question nobody asked your firm", "circular 230 and the tool your staff already use".

Never mention AI in the subject line of a first touch to a law firm - it reads as vendor spam before the email is opened.$t$,
null, 'email', 'proven'),

('rule', 'Cold email - what must never appear',
$t$Hard stops. Any of these means the draft is wrong and should be rewritten, not patched.

- An invented statistic, client result, or named reference. There is no case study yet.
- A claim that they have been breached, or that their data IS on someone's server. The honest claim is that they cannot know either way, and that is the point.
- Legal advice, or any statement about what a rule requires of them. Raise the rule, never interpret it for them.
- Any description of how the system is built.
- More than one question.
- The words "just following up".
- An attachment of any kind.$t$,
null, 'email', 'proven');

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select kind, vertical, title from brand_brain where channel='email' order by kind, title;
--   -- expect 11: 6 rule, 5 icp  (+ 'How Sanaku talks', pinned to email by 022)
--
--   select coalesce(channel::text,'(all channels)') ch, count(*)
--     from brand_brain group by 1 order by 1;
