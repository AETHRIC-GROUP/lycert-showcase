# Documentation

| Folder / file | What it contains |
|---|---|
| [`architecture/LYCERT_BRIDGE_ARCHITECTURE.md`](architecture/LYCERT_BRIDGE_ARCHITECTURE.md) | **Current roadmap.** The CRM + verification-provider orchestration model, the HubSpot and SheerID specifications, the keep/freeze/drop inventory, and milestones M0 to M5. Start here. |
| [`architecture/LYCERT_ARCHITECTURE.md`](architecture/LYCERT_ARCHITECTURE.md) | Original platform specification: product, legal framework, full data model, infrastructure, phased plan. Where the Bridge document contradicts it, the Bridge document wins. |
| [`architecture/ENGINE_CONSOLIDATION_PLAN.md`](architecture/ENGINE_CONSOLIDATION_PLAN.md) | Plan for moving from the Python service to a single TypeScript engine on a durable queue. |
| [`architecture/LYCERT_ENRICHMENT_ARCHITECTURE.md`](architecture/LYCERT_ENRICHMENT_ARCHITECTURE.md) | First enrichment design: pre-enrichment, provider roles, field mapping. |
| [`architecture/LYCERT_WATERFALL_ENRICHMENT_V2.md`](architecture/LYCERT_WATERFALL_ENRICHMENT_V2.md) | The multi-provider waterfall that runs today: registry, merge rules, async providers, budgets. |
| [`architecture/LYCERT_WATERFALL_ENRICHMENT_V3.md`](architecture/LYCERT_WATERFALL_ENRICHMENT_V3.md) | Evaluation of three additional providers (built, benchmarked, excluded). |
| [`architecture/LYCERT_VERIFICATION_ARCHITECTURE.md`](architecture/LYCERT_VERIFICATION_ARCHITECTURE.md) | Authoritative enrollment-verification layer (built, now frozen). |
| [`architecture/LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md`](architecture/LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md) | Document-review pipeline: AI-assisted extraction, process-and-purge retention, human review (built, dormant). |
| [`decisions.md`](decisions.md) | Condensed architecture decision log. |
| [`compliance/VERIFICATION_CONSENT_DRAFT.md`](compliance/VERIFICATION_CONSENT_DRAFT.md) | Draft consent text for the hosted verification flow. Not legally reviewed. |
| [`engineering-process/`](engineering-process/) | How the project is built with an AI coding agent, and the agent's rules file. |
| [`reference/`](reference/) | Synthetic fixtures for the scoring regression. |

The specifications were written before the code and were kept current as decisions changed. Code comments
cite them by part number (for example "Bridge Part 6.7"), so any rule in the code can be traced back to its
reasoning.

Code comments and the agent rules file also mention `STATUS.md`, `NEXT_STEPS.md` and `DECISIONS.md`. Those are the working repository's session logs and are not part of this copy. [`decisions.md`](decisions.md) condenses the decision log, and the root README describes the current status.
