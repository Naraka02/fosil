# Agent Notes

Document type: reference.

An Agent Note records a decision or proposal, its motivation, the alternatives considered, and the trade-offs that remain useful to future work. This file owns the note format and lifecycle. Follow the [note instructions](AGENTS.md) when editing this tree.

## Paths and discovery

Active notes use `.agents/notes/{lifecycle}/{class}/YYYY-MM-DD-topic.md`. The filename date is the date the topic was first proposed; it does not change when the note moves. Use a short English kebab-case topic name.

Create lifecycle and class directories only when a note needs them. Discover notes through the directory tree or repository search; do not create a centralized `INDEX.md`, a numbered catalog, or a second decision-record system. This README defines the system, not an inventory of its records.

Use relative Markdown links for cross-references, including links between notes and their owning documentation. Moving a note requires repairing inbound links and any outbound relative links affected by its new location.

## Lifecycle

| Directory | Meaning | Maintenance |
| --- | --- | --- |
| `proposed/` | A decision not yet implemented, including partial implementation | Keep the proposal and acceptance conditions accurate |
| `implemented/` | A decision effective in the repository and verified for its scope | Keep its factual realization and verification requirements current |
| `rejected/` | A considered proposal that was declined | Preserve the proposal and state the rejection reason |
| `archived/` | A formerly active implemented note retained as history | Freeze the content; never use it as current authority |

Approval alone does not make a proposal implemented. Move it only when the relevant change is effective and its acceptance conditions have been checked. Documentation and process decisions can be implemented without runtime code when their own scope is satisfied.

### Classes

| Class | Decision scope |
| --- | --- |
| `feature` | A new capability visible to a user or model |
| `bug-fix` | Correction of a defect |
| `simplification` | Removal or reduction of complexity or behavior without a new capability |
| `architecture` | Structure and responsibility boundaries of the product implementation |
| `process` | Documentation, policy, tooling, and development workflow |
| `testing` | Test strategy or test infrastructure |

Use one class per note. Documentation-system decisions belong to `process`, not `architecture`. Adding a class requires changing this rule through the normal decision process; do not create ad hoc class folders.

## When a note is required

Every non-trivial change adds or updates at least one owning Agent Note in the same logical change. This includes changes to behavior, architecture, shared contracts, development process or tooling, testing strategy, persistence or configuration formats, or another choice the maintainer may reasonably revisit.

Purely mechanical or local edits that do not change behavior, contracts, structure, process, or decision rationale are exempt. Spelling and formatting corrections are examples. The size of a diff alone does not decide whether a note is needed.

Update the note that already owns the decision when its rationale still applies. A substantial unsettled decision starts in `proposed/`; an already effective and verified decision may be recorded directly in `implemented/`.

A note is not a work log, transcript, task board, or duplicate specification. Put current contracts in their [owning documentation](../../docs/AGENTS.md#document-ownership) and link to them. Record only actual alternatives considered, not invented review discussions or a transcript of every local implementation choice.

## Note format

Each note starts with `# Agent Note: <title>`, a blank line, and a `Status:` line. Status values are exactly `proposed`, `implemented`, or `rejected - <one-line reason>`, and agree with the lifecycle directory. Do not add dates to the status; the filename carries the proposal date.

Use the following English headings. Additional sections are allowed when they carry necessary subject-specific content. Every note begins its body with `## Problem` and includes `## Alternatives considered` with the real alternatives and why they were not selected.

### Proposed template

```markdown
# Agent Note: <title>

Status: proposed

## Problem

## Proposal

## Alternatives considered

## Acceptance criteria

## Risks
```

Explain the problem independently of the chosen solution. Describe the intended decision, observable acceptance conditions, unresolved questions, and both risks and capabilities given up. Implementation planning may appear here while the work is not effective.

### Implemented template

```markdown
# Agent Note: <title>

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences

## Verification
```

Describe the effective decision in present tense. Link to the current contract instead of duplicating it. Consequences state the benefits, costs, and constraints of the choice. Verification states the checks that support the decision, relevant evidence, and known coverage gaps; never claim a check that was not run.

Do not keep proposal headings, migration plans, unfinished task checklists, or future-tense acceptance criteria in an implemented note. This project requires the `## Verification` section for implemented notes so the verification obligation remains visible.

### Rejected format

Keep the proposal body, including `## Problem`, `## Proposal`, and `## Alternatives considered`. Change the status to `Status: rejected - <one-line reason>`. Preserve what was actually considered; do not rewrite it into a different proposal after rejection.

## Transitions and continuing ownership

For `proposed/` to `implemented/`, move the file, update its status, rewrite Proposal as Decision, and replace acceptance criteria and risks with current Consequences and Verification. Remove execution plans and repair links in the same change.

For `proposed/` to `rejected/`, move the file, add the rejection reason, and repair links. A rejected proposal is not an implemented decision.

Keep paths, names, defaults, and other factual realization details current in an active implemented note without appending a change diary. Reversing a decision or changing its rationale requires a new note with links in both directions; do not overwrite the old decision with its opposite. An older partially superseded note remains active for the parts it still owns.

Archive only implemented notes whose rationale is unlikely to guide future work. Do not archive solely because of age, length, or a target count, and never archive a proposed note. Unneeded proposals are rejected instead.

The archive path is `.agents/notes/archived/{class}/YYYY-MM-DD-topic.md`. At archival, keep `Status: implemented`, insert `Archived: YYYY-MM-DD` immediately below it, and repair inbound links. Preserve the body as historical evidence. Once archived, do not edit, move, or delete the note, and do not require its outbound links to remain live. Active documents may link into the archive only with an explicit historical purpose.

Retain a rejected note while its rationale prevents a plausible repeated mistake. Removing an unneeded rejected note requires checking and repairing inbound references; normal [authorization rules](../../docs/development.md#git-and-delivery) still apply. This baseline does not define an automatic deletion or consolidation workflow.

## Reference

The lifecycle and classification approach is adapted from the upstream [DeepSeek Harness Agent Note rules](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/README.md). This file defines fosil's local rules; upstream scripts, translation metadata, and future upstream changes do not apply automatically.
