# Saved agents and run templates

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/agents.ts, agentRegistry.ts, templates.ts, modelCatalogue.ts, modelDiscovery.ts.**

Each paragraph is in one topic file under `docs/agent/agents-and-templates/`; the lines below are their lead claims, under the file that holds them.

## [Run templates and the model catalogue](agents-and-templates/templates-and-model-catalogue.md)

- A template is form input, and the two settings that decide what an agent may do are applied but announced.
- Model discovery adds to the catalogue and never edits it, and what it adds moves the install's default rather than its setting.

## [Saved agents: a role, refused at the door](agents-and-templates/saved-agents.md)

- A saved agent is the fourth thing here that is form input, and it carries a role rather than a capability.
- The CLI will not register a malformed agent, so this app refuses one at the door — and the singular flag changed how loudly that fails, not whether it does.

## [Agent references, and the agents this app did not write](agents-and-templates/agent-references-and-ambient-agents.md)

- A run records the agent it was started as; a template records the one it names; and the difference between a copy and a reference is the whole of it.
- The agents this app did not write are left in play and declared, never silently mixed.
- The mounted `settings.json` can name a session agent too, and that one is measured and *not* declared.
