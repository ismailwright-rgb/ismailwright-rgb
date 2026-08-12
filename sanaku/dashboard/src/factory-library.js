// GENERATED FILE — DO NOT EDIT.
//
// Written by `npm run sync:dashboard` in ~/sanaku-factory from
// packages/templates/library.json, which is the single source of pricing.
// Editing this by hand puts a second set of numbers into circulation, and
// the one people read is always the stale one.
//
// Synced from library version 1.

export default {
  "$comment": "THE SINGLE SOURCE OF PRICING. Mirrors the sanaku_addons discipline: no document may hand-type a figure that is not in this file. `node packages/launcher/src/audit-pricing.mjs` fails the build if one does.",
  "version": 1,
  "pricing": {
    "currency": "USD",
    "base": {
      "code": "privacy_base",
      "name": "Privacy foundation",
      "setup_fee": 4500,
      "monthly_fee": 650,
      "includes_workflows": 1,
      "blurb": "Local model, local database, routing layer and safeguards, installed on the firm's own hardware. Includes the first workflow.",
      "locked": true,
      "detail": "Ollama with the model matched to the firm's hardware, a self-hosted Supabase for all client data, the routing layer that keeps privileged work on-box, and the grounding, confidence, review-gate and narrow-scope safeguards. This is the floor of every build and cannot be removed."
    },
    "addon_workflow": {
      "note": "Each workflow beyond the first bills at its own monthly_fee below. Setup is charged once per workflow.",
      "default_setup_fee": 750,
      "default_monthly_fee": 200
    }
  },
  "hardware_tiers": [
    {
      "id": "entry",
      "label": "Entry",
      "hardware": "Standard business desktop, no dedicated GPU",
      "model": "llama3.2:3b",
      "alternates": [
        "llama3.1:8b"
      ],
      "strengths": "Runs on what they already own. Handles intake capture, form filling and known-question answering comfortably. Light reasoning — it will not do document analysis well.",
      "tradeoff": "Slower on long documents. Keep the scope to intake and FAQ.",
      "min_ram_gb": 8,
      "vram_gb": 0
    },
    {
      "id": "sweet_spot",
      "label": "Sweet spot",
      "hardware": "One consumer GPU, roughly 16-24 GB VRAM",
      "model": "llama3.1:8b",
      "alternates": [
        "qwen2.5:14b",
        "mistral-nemo:12b"
      ],
      "strengths": "Sharp, fast and private. The right answer for most small firms — good instruction-following for intake scripts, quick enough to feel live on a phone call, and strong enough to summarise a matter.",
      "tradeoff": "Not a research model. Layer document analysis on the power tier if the firm needs it.",
      "min_ram_gb": 16,
      "vram_gb": 16,
      "recommended": true
    },
    {
      "id": "power",
      "label": "Power",
      "hardware": "Workstation with high-memory card or cards",
      "model": "llama3.3:70b",
      "alternates": [
        "qwen2.5:72b"
      ],
      "strengths": "Overkill for pure intake. Worth it when document analysis or research is being layered on top, where the quality gap on long context actually shows.",
      "tradeoff": "Real hardware cost and slower per token. Do not sell this for intake alone.",
      "min_ram_gb": 64,
      "vram_gb": 48
    }
  ],
  "workflows": [
    {
      "code": "legal_intake",
      "name": "Client intake",
      "dir": "legal-intake",
      "category": "intake",
      "verticals": [
        "law",
        "medical",
        "accounting",
        "insurance",
        "mortgage",
        "property"
      ],
      "blurb": "Captures a new enquiry end to end, on the firm's own machine.",
      "detail": "Web form or phone transcript comes in, the local model works through the firm's approved intake script, fills the matter record, answers known questions from firm documents only, and hands anything that looks like advice to a human before it reaches the enquirer.",
      "setup_fee": 750,
      "monthly_fee": 200,
      "privacy_class": "always_private",
      "requires_credentials": [],
      "optional_credentials": [
        "smtp"
      ],
      "flagship": true,
      "template_status": "ready"
    },
    {
      "code": "conflict_check",
      "name": "Conflict check",
      "dir": "conflict-check",
      "category": "intake",
      "verticals": [
        "law"
      ],
      "blurb": "Screens a new enquiry against existing matters before anyone speaks to them.",
      "detail": "Runs the incoming party names against the local matter database and flags a potential conflict for a human. Entirely local — a conflict check is the last thing that should touch a third party.",
      "setup_fee": 750,
      "monthly_fee": 200,
      "privacy_class": "always_private",
      "requires_credentials": [],
      "template_status": "ready"
    },
    {
      "code": "matter_summary",
      "name": "Matter summary",
      "dir": "matter-summary",
      "category": "operations",
      "verticals": [
        "law",
        "medical",
        "insurance"
      ],
      "blurb": "A running plain-language summary of each matter, regenerated as notes land.",
      "detail": "Summarises case notes locally so a fee earner can pick a matter up cold. Never leaves the machine.",
      "setup_fee": 750,
      "monthly_fee": 200,
      "privacy_class": "always_private",
      "requires_credentials": [],
      "template_status": "planned"
    },
    {
      "code": "statute_lookup",
      "name": "Statute and definition lookup",
      "dir": "statute-lookup",
      "category": "research",
      "verticals": [
        "law"
      ],
      "blurb": "Generic legal lookups, routed to a public model for horsepower.",
      "detail": "The one workflow that is allowed to leave the building, because by construction it carries no client fact. Every request still passes the classifier and the egress guard, and anything carrying a name or matter number is pulled back to local automatically.",
      "setup_fee": 750,
      "monthly_fee": 200,
      "privacy_class": "may_egress",
      "requires_credentials": [
        "anthropic_api_key"
      ],
      "template_status": "ready"
    },
    {
      "code": "missed_call_intake",
      "name": "After-hours and missed-call intake",
      "dir": "missed-call-intake",
      "category": "intake",
      "verticals": [
        "law",
        "medical",
        "property"
      ],
      "blurb": "Catches the enquiry that arrives when nobody is at the desk.",
      "detail": "Takes the voicemail or after-hours form, runs the intake script locally, and has a completed matter record waiting in the morning.",
      "setup_fee": 750,
      "monthly_fee": 200,
      "privacy_class": "always_private",
      "requires_credentials": [
        "twilio"
      ],
      "optional_credentials": [
        "smtp"
      ],
      "template_status": "planned"
    }
  ],
  "$comment2": "template_status is derived from what is actually in workflows/. A workflow marked planned is advertised but not yet buildable — validateConfig refuses it and the factory shows it disabled, so an operator can never select a workflow that would fail at assembly."
};
