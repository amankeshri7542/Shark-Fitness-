# Prompt guide notes (Anthropic official, fetched 2026-11-23)
Sources:
- https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices (Prompting best practices, current models incl. Opus 5.5)
- https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
- https://www.anthropic.com/engineering/claude-code-best-practices (-> code.claude.com "Best practices for Claude Code")

## General principles applied to every phase prompt
1. Be clear and direct: treat Claude as a brilliant new employee with no context. Specific output, numbered steps when order matters.
2. Give context / the WHY behind each constraint (Claude generalizes from the reason).
3. Structure with consistent XML tags: <role>, <context>, <task>, <constraints>, <acceptance_criteria>, <verification>, <deliverables>.
4. Role: one line sets focus ("senior full-stack engineer delivering to a paying client").
5. Examples where format matters (e.g. the PHASE-PLAN format / final report format).
6. Say "be ambitious" when the fuller version is wanted (edge cases, empty/error/loading states) - Claude reads scope conservatively otherwise.
7. Avoid over-engineering: only changes clearly needed; no speculative abstractions; validate only at boundaries.
8. Don't game tests: general solutions, no hardcoding; never delete/weaken tests; report incorrect tests instead.
9. Investigate before answering: never speculate about code not opened.
10. Reversibility/safety: local reversible actions OK; no force-push, no reset --hard on shared refs, no --no-verify, no deploys, no real secrets, no real money.
11. Payments block (Anthropic recommends for anything payment-related): never initiate real payments; test/sandbox only.
12. Clean up temporary scratch files at the end.

## Claude Code specifics
- "Tell Claude what it can't see": constraints that live in people's heads (Aman's rules, branch/PR rules, no deploy) go in the prompt.
- "Give Claude a check to run": name the exact commands (typecheck, lint, test, build, e2e) and require evidence (command + output summary) in the final report.
- Review with a fresh session against the spec ("review against acceptance criteria, report gaps that affect correctness, skip style") - a fresh reviewer helps because it didn't see the reasoning.
- Unattended runs: define done, give a check, limit what it touches (branch only), cap with --max-turns, result goes to a PR a person approves.
- Phrases like "think hard"/"don't be lazy" are not needed; effort level is the control. Use --effort high for build phases.
- Long tasks: state tracking in files (progress notes + structured JSON for tests) and git commits as checkpoints; context will auto-compact so don't stop early; commit incrementally so no big uncommitted work.
- Plan first for big phases (write the plan into the phase notes file, then implement).

## Opus 5.5 specifics
- Effort default medium; set explicitly; high for heavy coding, xhigh only where needed.
- Unattended runs may end turn with a progress report while items are open -> keep a checklist file; runner re-prompts "continue with open items" up to 2-3 times.
- Frontend defaults: name specific patterns to avoid (cream backgrounds, italic accent headline words, 01/02/03 labels, monospace labels, pill buttons everywhere) and point to the project's Design PRD as the source of truth.
