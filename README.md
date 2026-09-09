I build production AI automation for revenue operations — voice agents that answer and book, LLM pipelines that qualify with a stated rationale, and outbound systems that run unattended without creating legal exposure.

## The through-line

**I find the revenue leak nobody is measuring, build the system that closes it, and prove the number.**

At a Los Angeles logistics facility I built the shipment tracking infrastructure from scratch. Orders were being marked complete while part of the shipment still sat elsewhere in the building, and the gap only surfaced when a retailer flagged the shortage and issued a chargeback. The tracking system caught the gap before it shipped, and catching it there is what prevented roughly **$120,000 a month** in chargebacks. I supervised a floor team of about 40 while it was running.

Same move in a CRM. Expired-but-previously-interested contacts sit in every sales org, already paid for, and nobody works them because the hit rate doesn't justify a rep's hours. I stitched three APIs that had never spoken to each other — Pipeline CRM, RingCentral SMS, and the calendar — into a single path from dead record to booked call. A conversational agent re-engages, qualifies whether the person still intends to exit their timeshare, and books the discovery call. It books **6–8 appointments a week with no human in the loop**.

That system is also where the engineering matters most: **opt-out suppression and quiet hours (8am–8pm in the recipient's local timezone) are enforced at the send-queue layer as hard gates, not as branches inside the conversation.** Compliance written as a prompt fails the first time the model improvises. Compliance written as a gate cannot be talked around, even when every other part of the system tries to.

One warehouse, one CRM, same move.

## Systems

**[ai-systems-portfolio](https://github.com/ismailwright-rgb/ai-systems-portfolio)** — architecture, design decisions, and diagrams for five builds:
[Voice AI Intake](https://github.com/ismailwright-rgb/ai-systems-portfolio/tree/main/01-voice-intake) ·
[Intent Monitoring Pipeline](https://github.com/ismailwright-rgb/ai-systems-portfolio/tree/main/02-intent-pipeline) ·
[Alfred (multi-agent)](https://github.com/ismailwright-rgb/ai-systems-portfolio/tree/main/03-alfred-multi-agent) ·
[ATS Scanner](https://github.com/ismailwright-rgb/ai-systems-portfolio/tree/main/04-ats-scanner) ·
[Lead Reactivation](https://github.com/ismailwright-rgb/ai-systems-portfolio/tree/main/05-lead-reactivation)

## Stack

n8n · Vapi · Supabase/Postgres · Python · React · Netlify · ElevenLabs · OpenRouter · Apollo · RingCentral API · calendar API

## Open to

Solutions Engineer · GTM Engineer · Forward Deployed Engineer · Deployment Strategist — Los Angeles, open to remote.

[ismailwright@gmail.com](mailto:ismailwright@gmail.com) · [LinkedIn](https://linkedin.com/in/thekeyispersistence) · [Portfolio](https://portfoliowright.vercel.app)
