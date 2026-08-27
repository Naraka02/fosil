# Documentation standard

This file owns documentation placement, language, writing, and maintenance rules. Follow the [repository instructions](../AGENTS.md). The [documentation system Agent Note](../.agents/notes/implemented/process/2026-08-27-documentation-system.md) records the rationale.

## Document ownership

Each fact has one owning document. Other documents link to that owner rather than restating its detail. A document covers its own subject; it introduces direct children only by purpose, responsibility, and high-level behavior.

| Tier | Owns | Does not own |
| --- | --- | --- |
| Root README | Project introduction and entry links | Development rules or detailed contracts |
| Root AGENTS.md | Brief standing instructions and links to their owners | Procedures, examples, or decision narratives |
| Subtree AGENTS.md | Instructions specific to that subtree | Repeated repository-wide rules |
| Documentation guide | Reading routes | Task status or exhaustive inventories |
| Development guide | Working process, verification, and Git conventions | Decision rationale or product design |
| Agent Notes | Decisions, alternatives, consequences, and required verification | General task logs or duplicated current contracts |
| Architecture reference, when needed | System composition and responsibility boundaries | Detailed subsystem contracts or decision history |
| Subsystem references, when needed | Each subsystem's types, semantics, and contracts | Other subsystems' details |
| Module README, when needed | The module's configuration, behavior, limitations, and extension contract | Other modules' contracts or copied source catalogs |
| Cookbooks, when needed | Task-oriented procedures with observable verification steps | Decision rationale |
| User guides, when needed | Product use from the user's perspective | Contributor procedures |
| Postmortems, when needed | Incident evidence, impact, causes, and corrective lessons | General decision or project history |
| Generated references, when needed | Information derived from an identified authoritative source | Manual edits to generated output |
| Project skills, when needed | Reusable specialized workflows | Product contracts or duplicated standing rules |

Create a document or directory only when it has actual content and an owner. Do not create empty architecture, subsystem, cookbook, user, or postmortem scaffolding. These tiers describe where future content belongs, not a commitment to a product architecture or source layout.

## Document forms

Human-facing explanatory documents identify their form as `Document type: reference.` or `Document type: tutorial.` Navigation READMEs are references. Instruction files use the `AGENTS.md` form; Agent Notes use their [lifecycle-specific format](../.agents/notes/README.md#note-format).

A reference defines a lookup scope and current facts. A tutorial takes a reader from stated prerequisites to an observable outcome, introducing prerequisites before dependent concepts. Split substantial mixtures into separate documents; label a short embedded tutorial or reference section explicitly.

Agent Notes are outside the tutorial/reference split and current-state-only rule where their lifecycle requires proposal or historical content. Their own rules govern those differences.

## Language and writing

- Maintain repository documentation, instructions, templates, and Agent Notes in English only. Use English filenames and stable metadata tokens; do not create translated counterparts.
- Describe current facts in durable references. Keep proposals and decision rationale in Agent Notes, and incident chronology in postmortems. Do not add task progress annotations or change-by-change narratives to references.
- Write one physical line per paragraph and use editor soft wrap. Preserve the necessary structure of lists, tables, and fenced blocks.
- Name the actor, behavior, constraint, and consequence directly. Remove reasoning transcripts, decorative emphasis, and prose that merely restates code.
- Document only commands and capabilities that exist. Mark an illustrative example as an example; do not present planned tests, tooling, or automation as available.
- Do not manually duplicate source-derived catalogs or exhaustive lists that another owner maintains. Link to their owner.

## Links and maintenance

Use relative Markdown links for existing repository documents and references, including Agent Notes. Use descriptive link text and valid heading fragments; bare filenames or note numbers do not replace links. Use full URLs for external sources.

Names of not-yet-created tiers may appear as explicitly conditional descriptions, not links to missing files. When moving or renaming a file or heading, repair inbound links in the same change. Link to archived notes only as historical evidence.

Update the owning document in the same change that alters its documented facts. Keep routing pages small. When a page grows, first move misplaced detail to its owner, then shorten redundancy; do not delete necessary contracts just to meet a length target.

Document review checks ownership, English-only prose, form, links and fragments, current facts, note lifecycle consistency, and unnecessary duplication. There is no automated documentation checker or enforced word-count budget in this baseline. The [development guide](development.md#documentation-checks) owns the review procedure.
