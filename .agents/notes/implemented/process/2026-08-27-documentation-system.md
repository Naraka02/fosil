# Agent Note: Documentation system and development conventions

Status: implemented

## Problem

fosil needs a documentation system that a single maintainer and coding agents can keep accurate without committing to a product architecture or technology stack. Repository instructions need to remain small, current facts need a clear owner, and decisions need enough rationale to avoid repeated debate across tasks.

## Decision

The repository uses the ownership tiers defined by the [documentation standard](../../../../docs/AGENTS.md#document-ownership). The [documentation guide](../../../../docs/README.md) routes readers, while the [development guide](../../../../docs/development.md) owns the working process. Agent instructions point to those owners.

Agent Notes are the sole durable decision-record format, with paths, lifecycle, classification, and templates defined in the [note rules](../../README.md). This decision belongs to the process class because it governs development rather than the coding agent's implementation.

The maintainer's choice of English as the single documentation language is reflected in the [language rule](../../../../docs/AGENTS.md#language-and-writing). It gives humans and agents one maintained version without translation pairing.

Directories are created only for actual content. The document taxonomy provides homes for future material without asserting that product modules or architecture already exist. The baseline includes manual [documentation checks](../../../../docs/development.md#documentation-checks); it does not install a toolchain, hooks, or CI.

The system is adapted from the upstream [documentation standard](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md), [Agent Note rules](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/README.md), and [implemented-note instructions](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/AGENTS.md). These are design references, not inherited repository instructions or an automatic synchronization source.

## Alternatives considered

**Adopt the complete upstream setup.** The upstream repository's bilingual pairing, generated references, hard budgets, and validation scripts bring dependencies and maintenance obligations that this repository does not yet need. The local baseline retains the ownership and decision-record mechanisms without claiming those tools exist.

**Use Chinese-only or bilingual documentation.** Chinese-only prose was part of the initial proposal; the maintainer selected English-only documentation. Bilingual documents add a second version and a consistency obligation, so they are not included.

**Maintain a separate ADR tree or centralized note index.** A second decision-record system competes with Agent Notes for ownership, while a manual inventory duplicates information in paths. Lifecycle and class directories plus search provide discovery without another maintained catalog.

**Precreate the complete documentation tree.** Empty architecture, subsystem, and product-guide documents imply decisions or content that do not exist. Conditional tier definitions preserve a place for future documentation without placeholder files.

**Require a pull request and complex checks for every change.** Mandatory review ceremony and a full validation toolchain add overhead for a single maintainer at this stage. The working process instead requires scoped changes, explicit verification, and synchronized owning documents, without making a pull request mandatory.

## Consequences

The repository has one place for current contracts and another for their decision rationale, with short instructions and links between them. Maintaining this separation requires deliberate placement review; a routing document cannot grow into a second owner.

English-only documentation avoids translation maintenance but provides no maintained Chinese counterpart. On-demand directories avoid empty scaffolding but require the author to consult the ownership table when introducing a new topic.

Manual review has no automatic enforcement against broken links, stale metadata, or excessive document size. These remain explicit review obligations. Adding automated checks or changing the process is a separate decision when the need and implementation are concrete.

The baseline makes no decision about the coding agent's runtime, components, model integration, tools, persistence, interfaces, or testing framework. A documentation-tier name is not evidence of a product architecture decision.

## Verification

The baseline's verification covers the presence and ownership of its documents, relative links and heading fragments, English-only prose, paragraph and whitespace formatting, and this note's filename, class, status, and required sections. Review also checks that no document claims unavailable scripts or unperformed runtime tests.

The first note records an effective documentation and process decision, not an approval for unfinished product work. Subsequent edits use the same [documentation review procedure](../../../../docs/development.md#documentation-checks).

There is no committed validation script, automated documentation gate, or runtime test suite. Link and format checks do not prove that every future edit will preserve semantic ownership; that remains a review responsibility.
