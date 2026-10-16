# Engineering process

Lycert is built by one founder working with an AI coding agent, Claude Code. The agent writes most of the
implementation. The founder owns the product, architecture, decisions, infrastructure and acceptance. This
folder documents how that collaboration is structured, because the structure is what keeps the output
reliable.

## The workflow

```
 specification ──▶ milestone plan ──▶ approval ──▶ build ──▶ live verification ──▶ acceptance
       ▲                                                                              │
       └──────────────────── decisions and status recorded ◀─────────────────────────┘
```

1. **Specification first.** Each subsystem has a written specification in `docs/architecture/` before any
   code. Specifications mark external facts that could not be confirmed as `[VERIFY AT BUILD]`. The agent
   must confirm those against the vendor's live documentation, and log the confirmation, before relying on
   them.
2. **Plan, then approval.** At the start of a milestone the agent checks the specification's stated baseline
   against the actual repository, writes a short concrete plan, and waits for approval.
3. **Build with tests.** Pure logic is separated from I/O so that it can be tested exhaustively. The suite
   must stay green before any push.
4. **Live verification.** Each milestone is exercised against the real third-party system on staging, using
   synthetic data.
5. **Acceptance.** A milestone closes only when the founder has checked the outcome in the real system. The
   next milestone does not start before that.
6. **Recorded state.** At the end of each session the agent updates three files in the working repository:
   a status file, a next-steps file, and a decision log of context, decision, alternatives and evidence.
   Any later session can resume from them alone.

## Guardrails

The rules file, [`CLAUDE.md`](CLAUDE.md), is loaded at the start of every agent session. It is included here
unchanged except for redacted identifiers, and it references the working repository's status files, which
are not part of this public copy. Its key rules:

- **Branch discipline.** The agent works on `develop` and may push to `staging`. Only the founder releases to
  production.
- **Stop and ask** before anything touching legal or GDPR constraints, database schema, scoring output,
  security, or phase scope.
- **No secrets in code.** Every new environment variable is recorded with the environments it is set in.
- **Migrations are immutable** once applied. Every table gets row-level security in its creating migration.
- **UI work counts as done only once it is deployed** to staging and the deployment is verified as ready.

## Tooling

- **MCP servers** give the agent direct, scoped access to Supabase (SQL and migrations), Vercel (deployments,
  logs, project settings) and HubSpot (developer tooling). Most diagnosis happened from primary evidence,
  such as runtime logs, project settings and DNS lookups, rather than guesses.
- **Human-only operations.** Some actions were left to the founder even when a tool could technically do
  them: production releases, DNS changes on the live domain, and reading or embedding secrets without
  explicit approval.

## What worked, and what didn't

- **Worked:** holding the agent to "verify against live docs, don't invent" eliminated a class of
  integration bugs. Honest status reporting, where failures stay recorded as failures, made it possible to
  trust "accepted".
- **Worked:** the pure-core/injected-I/O pattern made every worker, retry path and legal invariant testable,
  and those tests are what make agent-written code reviewable.
- **Didn't, at first:** an agent can confidently fix the wrong root cause. In the webhook incident the first
  fix was real but not the blocker. The process that caught it was evidence-first diagnosis plus a second
  review, not more confidence.
- **Didn't, at first:** fake-I/O tests passed while a real SQL query was wrong. Live acceptance runs are a
  required step in the workflow for this reason.
