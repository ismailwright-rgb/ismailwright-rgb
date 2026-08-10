-- ============================================================================
-- Seed - the LinkedIn brand brain
--
-- RUN THIS AFTER migration-022-marketing-studio.sql, as a separate statement
-- batch. It inserts rows tagged with verticals that 022 adds to the enum, and
-- Postgres refuses to use a new enum value in the transaction that created it.
--
-- Every row here is channel = 'linkedin'. Nothing outbound is touched. The
-- generator reads these rows on every run, which is what lets the positioning
-- change without editing the n8n workflow - the whole point of Step 3.
--
-- WHY THESE ROWS HAVE NO EMBEDDING
-- brand_brain.embedding drives match_brand_brain(), the pgvector top-k search
-- that "03 Research and Draft" uses to pull the few most relevant snippets for
-- one specific lead. The content studio wants the opposite: the WHOLE brief,
-- every time, so voice and positioning stay identical across formats. So the
-- generator selects these by plain filter (channel, vertical, kind) and never
-- calls match_brand_brain. Leaving embedding NULL is deliberate, not an
-- oversight - and it also keeps these rows from polluting the outbound
-- similarity search, which would otherwise start returning LinkedIn voice
-- rules inside cold emails.
--
-- ON SAYING "AI"
-- The outbound rule "How Sanaku talks" says not to use the word - correct for
-- cold email, where it reads as a buzzword. Migration 022 pins that rule to
-- channel 'email' precisely so it does not reach here. On a personal profile
-- positioned around privacy-safe AI, naming AI is the subject, not a buzzword.
--
-- Safe to run more than once - it clears the linkedin channel first.
-- ============================================================================

delete from public.brand_brain where channel = 'linkedin';

-- ----------------------------------------------------------------------------
-- Positioning
-- ----------------------------------------------------------------------------
insert into public.brand_brain (kind, title, content, vertical, channel, status) values
('offer', 'Positioning - AI that never leaves your building',
$t$The one line everything ladders back to: "AI that never leaves your building."

Ismail builds local, in-house AI systems for firms that run on confidentiality. The system is installed where the firm already keeps its files. Client data is not sent to a public AI service, not used to train anyone's model, and not held by a vendor who can be breached, subpoenaed, or acquired.

The contrast that does the work: most AI tools a firm can buy are a pipe to somebody else's servers. Paste a client file into a public chatbot and it has left the building - and in a regulated practice, that is not a preference, it is an exposure.

What that buys the firm: the productivity of AI without handing custody of client information to a third party.

Never phrase it as "more secure" in the abstract. Phrase it as WHERE THE DATA PHYSICALLY GOES. That is the whole argument and it is concrete.$t$,
null, 'linkedin', 'proven'),

-- ----------------------------------------------------------------------------
-- Voice
-- ----------------------------------------------------------------------------
('brand_voice', 'How Ismail writes on LinkedIn',
$t$First person, always. This is Ismail's personal profile, not a company page. "I" and "I've seen", never "we at Sanaku" or "our team". No corporate plural. No press-release register.

A builder who has done the work. The authority comes from having actually built the thing, not from credentials or predictions. Write from what you have seen while installing systems inside real firms.

Plain and confident. Short sentences. Concrete nouns - a phone, a file, a folder, a server in a closet. No hype, no "revolutionary", no "game-changing", no emoji walls, no "🚀". No "In today's fast-paced world". No engagement bait ("Agree? 👇").

Teaching, not selling. Every item should leave the reader knowing something they did not know, whether or not they ever hire anyone. That is what makes the profile a source people follow. The sale is a side effect of being the person who explained it clearly.

Generous, not superior. Never write down to the reader. The audience is smart people who are experts at law or accounting or therapy and are not obliged to be experts at AI. Confusion about AI is reasonable, not stupid.

Specific over sweeping. "A firm I worked with had 40% of after-hours calls go to voicemail" beats "many firms struggle with intake". If there is no real number available, describe the mechanism instead of inventing a statistic.

Length: a text post is 120-200 words. Hook in the first two lines - LinkedIn truncates around there and the reader decides on those alone. One idea per post.$t$,
null, 'linkedin', 'proven'),

('voice', 'LinkedIn openers - pattern-match these',
$t$Lines in the right register. Use them as tuning forks, not templates - do not reuse them verbatim.

"Your AI tool has a mailing address. Most people never ask where it is."

"A partner asked me last week whether summarizing a deposition in ChatGPT counts as disclosure. Good question. Here's the part nobody tells you."

"There are two ways to put AI in a law firm. One of them sends your client files to a company you've never met."

"I install these systems for a living, so here's the boring version of how this actually works."

"Nobody gets in trouble for the AI they didn't use. They get in trouble for where the file went."

"Every firm I walk into has the same three bottlenecks. None of them are exciting. All of them cost money."

Notice: no throat-clearing, no "I'm excited to share", the concrete thing first.$t$,
null, 'linkedin', 'proven'),

-- ----------------------------------------------------------------------------
-- Guardrails
-- ----------------------------------------------------------------------------
('rule', 'Sell the what and the why, never the how',
$t$Explain what the system does and why it matters. Never explain how it is built.

Fine to say: it runs locally; it never sends client data out; it answers calls after hours; it drafts the intake summary; it stays inside your existing folders.

Never say: the model name or size, the framework, the orchestration tool, the hosting setup, the vector store, the prompt structure, any architecture diagram, or any step-by-step that would let a reader rebuild it.

The test: after reading, could someone technical reproduce the system? If yes, cut it back. Could a managing partner decide whether they want it? If no, add to it.

This is not secrecy for its own sake. The audience does not want a build guide - they want to know whether this solves their problem and whether it is safe. The how is the part they are paying to not have to think about.$t$,
null, 'linkedin', 'proven'),

('rule', 'No invented proof',
$t$There is no client case study yet. Do not manufacture one.

Never write: a named or thinly anonymized client result, a specific revenue figure attributed to a real firm, a testimonial, a percentage improvement, or "one of my clients saw X" - unless a row of kind 'case_study' with status 'proven' exists in this brain and says so.

What is honest today: the mechanism, the risk, the arithmetic of a generic firm, what Ismail has observed while building, and clearly-labelled hypotheticals ("say a firm takes 200 calls a week").

If a post needs a number to land and no real number exists, either use a sourced public statistic with the source named, or restructure the post so the mechanism carries it. A made-up number is the fastest way to lose a room of lawyers and accountants, who are professionally trained to check them.$t$,
null, 'linkedin', 'testing'),

('rule', 'The five bottlenecks',
$t$Every item targets exactly ONE of these. Never two. The bottleneck goes in content_queue.bottleneck.

missed_calls - Calls and enquiries that go unanswered or get a slow callback. After hours, lunch, while the one person who answers the phone is with someone else. In an intake-driven practice the caller simply rings the next firm. The lost revenue is invisible because it never enters any system.

data_exposure - Staff pasting client information into public AI tools. Usually well-meaning and usually invisible to leadership: a paralegal summarizing a medical record, a bookkeeper cleaning up a client's ledger, a therapist drafting session notes. The firm has no log of it and no policy that covers it.

compliance_pressure - HIPAA, attorney-client privilege, the duty of confidentiality, financial-data rules, state bar guidance on AI. Rules that were written before these tools existed and are now being applied to them. Leadership feels exposed and does not know what "compliant AI" would even look like.

loss_of_control - The fear underneath the other three. Not knowing where the data went, what the vendor can do with it, what happens if the vendor is breached or sold, or whether you could even answer a client who asked. Being unable to give a straight answer is its own problem.

paperwork_load - Qualified people doing unqualified work. Intake forms, file summaries, notes, follow-up emails, chasing documents. Expensive hours spent on things that are necessary but not the practice.$t$,
null, 'linkedin', 'proven'),

-- ----------------------------------------------------------------------------
-- Audience, in priority order
-- ----------------------------------------------------------------------------
('icp', '1. Personal injury law firms',
$t$Top priority - write for this reader by default unless the rotation says otherwise.

Solo and small PI firms, roughly 1-15 staff, competing on speed to the injured caller. The first firm to pick up usually gets the case, so a missed call is a lost case, not a lost message. Typically one daytime receptionist and voicemail after that.

What they carry: attorney-client privilege and the duty of confidentiality. Medical records in nearly every file. State bar guidance on AI that is new, vague, and getting stricter.

What lands: missed calls as lost cases; whether a public AI tool breaks privilege; what happens to a medical record pasted into a chatbot; intake burden on people who should be working cases.

Their language: intake, case, client, retainer, demand letter, records, the file. Not "leads", not "customers", not "tickets".$t$,
'personal_injury_law', 'linkedin', 'proven'),

('icp', '2. Accounting and tax firms',
$t$Second priority.

Small and mid-size accounting, bookkeeping and tax practices. Brutally seasonal - the busy season decides the year, and capacity during it is the constraint on everything.

What they carry: SSNs, full financial pictures, business books, IRS Circular 230 obligations, and the fact that a client's entire financial life sits in one folder.

What lands: staff pasting client books or returns into public AI during crunch; the volume of client questions that never get answered fast enough in season; how much of the work is document chasing; what "where does the data go" means when the data is a tax return.

Their language: clients, engagement, return, books, close, busy season. Not "cases".$t$,
'accounting_tax', 'linkedin', 'proven'),

('icp', '3. Therapy and counseling practices',
$t$Third priority. Handle with the most care of the five - the confidentiality here is clinical and ethical, not just contractual.

Solo practitioners and small group practices. Often no admin staff at all; the clinician is also the receptionist, the biller, and the note-taker, between sessions.

What they carry: HIPAA, clinical notes, and a duty of confidentiality that is central to whether therapy works at all. A breach is not an inconvenience, it is a harm to a patient.

What lands: missed calls from people in distress who will not call twice; notes and documentation eating evenings; whether a transcription or note-taking AI is HIPAA-safe and what a BAA does and does not cover; the specific danger of a general chatbot touching session content.

Never be flippant about patients. No "leads". No urgency-selling on someone's mental health crisis. Their language: clients or patients, sessions, notes, practice, intake.$t$,
'therapy', 'linkedin', 'proven'),

('icp', '4. Financial advisors and wealth managers',
$t$Fourth priority.

RIAs and small advisory practices. Relationship businesses where responsiveness is the service and trust is the whole product.

What they carry: SEC and FINRA obligations, Reg S-P, books-and-records and communications-archiving rules, and complete pictures of client wealth. Compliance review of anything client-facing is routine and expected.

What lands: whether an AI tool creates a record they are required to retain and cannot produce; client data in a vendor's cloud; meeting notes and follow-ups consuming the day; being able to give a compliance officer a straight answer about where data lives.

Their language: clients, accounts, AUM, compliance, the CCO, suitability. They will ask about audit trails - that is a real question, not an objection.$t$,
'financial_advisory', 'linkedin', 'proven'),

('icp', '5. Family offices',
$t$Fifth priority - smallest audience, highest sensitivity, longest cycle. Write for them less often, and never write down to them.

Single and multi-family offices. Very small teams handling extremely private information for a very small number of people. Discretion is the product.

What they carry: no meaningful appetite for third-party data risk, personal and family information well beyond financials, and principals who will ask directly where something runs.

What lands: absolute data locality - the system is here, it does not phone home; concierge-level responsiveness without adding headcount; that no vendor holds the family's information; that this is not an off-the-shelf SaaS everyone else also uses.

Tone: quiet and understated. No urgency, no scarcity, no growth talk. They are not trying to scale. Their language: the family, the principals, the office. Never "customers".$t$,
'family_office', 'linkedin', 'proven'),

-- ----------------------------------------------------------------------------
-- Format briefs
-- ----------------------------------------------------------------------------
('rule', 'Format brief - what each LinkedIn format is for',
$t$One brand brain, six shapes. Each pulls the same positioning and voice; only the container changes.

post - the daily driver. Hook (1-2 lines, must survive truncation), body (the teaching), takeaway (one line the reader could repeat to a partner). 120-200 words. One bottleneck.

carousel - the authority builder. 5-8 slides, a real teaching sequence, not a post chopped up. Slide 1 is the promise ("5 questions to ask before you let any AI touch client files"), the middle slides are one idea each with under 25 words, the last is the takeaway. Must be useful screenshotted with no caption.

poll - engagement plus market signal. One plain question, 2-4 options. The question should be one the reader genuinely does not know the answer to about their own firm - "Do you know where your AI tool sends client data?" - not a leading question with an obvious right answer.

article - long-form on ONE bottleneck, 700-1200 words, deeper than a post can go. Real structure with subheads. Earns the "how it actually works" register without crossing the what/why/never-how line.

newsletter - a "The Private Practice" edition. Ties the week's theme together, more personal than an article, written to someone who chose to subscribe. Recurring shape so it feels like a series.

featured - the pinned proof pieces on the profile. Not timely; refreshed rather than published. Three of them: the "what we do" one-pager, the before/after visual, and the "hidden risk" explainer.

video - Phase 2. Do not generate.$t$,
null, 'linkedin', 'proven'),

('offer', 'The Private Practice - the newsletter',
$t$Name: The Private Practice.

Works on both meanings at once - the private practice as the business these readers run, and privacy as the thing the newsletter is about. It reads as belonging to the reader's world rather than to a vendor.

Promise: what a builder actually sees inside confidential firms, and what it means for yours. One idea per edition, written to be useful even to a reader who will never hire anyone.

Register: the most personal of the formats. First person throughout, closest to how Ismail would explain something to one managing partner across a desk. It may reference the week's posts, but it must stand alone.

Sign-off is consistent edition to edition. No "hit subscribe" begging.$t$,
null, 'linkedin', 'proven'),

('message_snippet', 'Featured assets - the three pinned pieces',
$t$The Featured section is the profile's storefront. Three pieces, refreshed rather than reposted.

1. What I do, on one page. Plainly: I build AI systems that run inside your building, for firms that cannot let client data leave. Who it is for, what it does, what it does not do. No pricing, no funnel language.

2. Before / after. One visual. Before: client file leaving the building for a third-party service, staff on hold, calls to voicemail. After: the same work happening with everything inside the building. The whole argument in one image, legible with no caption.

3. The hidden risk explainer. The one most firms have not thought about - staff already using public AI on client data, with no policy and no log. Names the risk, explains the mechanism, and stops short of the fix, because the fix is the conversation.$t$,
null, 'linkedin', 'proven'),

-- ----------------------------------------------------------------------------
-- Objection handling
-- ----------------------------------------------------------------------------
('objection', 'Objections that show up in the comments',
$t$Answer in the post's own voice - calm, specific, never defensive. These are for tone, not copy-paste.

"Isn't this just fear-mongering about ChatGPT?" - No. The tools are genuinely useful. The point is where the data goes, which is a separate question from whether the tool works. Both things are true.

"Our vendor says they don't train on our data." - Good, and worth having in writing. Training is one exposure. Retention, subprocessors, breach, subpoena and acquisition are others. The question is not only what they do with it, it is who has custody.

"We already have an IT provider / a policy." - Then you are ahead of most. A policy tells people what not to do; it does not tell you what they did. Most firms have no log of what has already been pasted where.

"This sounds expensive." - Do not discuss price on the profile. Move to the mechanism, or say plainly that it depends on the practice.

"Local AI isn't as good as the big models." - A fair point, honestly engaged. It is a real trade-off, it is narrowing, and for the specific jobs a firm needs done, the gap is usually not the deciding factor. Never overclaim here - the people who know will know.$t$,
null, 'linkedin', 'testing');

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select kind, vertical, status, title
--     from brand_brain where channel = 'linkedin'
--    order by kind, title;
--   -- expect 15 rows: 5 icp, 4 rule, 2 offer, 1 brand_voice, 1 voice,
--   --                 1 message_snippet, 1 objection
--
-- Outbound must be untouched apart from the one intentional re-pin:
--
--   select title, channel from brand_brain where channel is distinct from 'linkedin';
--   -- expect the original 12, with 'How Sanaku talks' now channel = 'email'
--   -- and the other 11 still NULL.
