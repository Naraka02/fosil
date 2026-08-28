# Documentation guide

Document type: reference.

This page routes readers to the owner of a topic. It is not a progress tracker or an inventory of every document and Agent Note.

## Reading routes

| Need | Read |
| --- | --- |
| Understand the project at a glance | [Project README](../README.md) |
| Understand the approved first release | [Product scope and acceptance conditions](product-scope.md) |
| Understand the current implementation | [Architecture and package boundaries](architecture.md) |
| Understand event validation and state transitions | [Execution events and state reduction](execution-events.md) |
| Understand durable command acceptance and storage | [Event store and command acceptance](event-store.md) |
| Understand restart and future model-history construction | [Startup recovery and model history](recovery.md) |
| Understand tool approvals and durable dispatch | [Tool execution](tool-execution.md) |
| Understand direct file access and edit evidence | [File tools](file-tools.md) |
| Understand shell output and live process cleanup | [Shell tools](shell-tools.md) |
| Begin an agent-assisted task | [Repository instructions](../AGENTS.md), then instructions in the affected subtree |
| Make and verify a change | [Development guide](development.md) |
| Place or edit documentation | [Documentation standard](AGENTS.md) |
| Propose or revisit a decision | [Agent Note rules](../.agents/notes/README.md), then the relevant active note |
| Understand the documentation system's rationale | [Documentation system decision](../.agents/notes/implemented/process/2026-08-27-documentation-system.md) |

## Finding the owner

The [ownership table](AGENTS.md#document-ownership) defines the document tiers, including tiers created only when there is content to maintain. Start with the nearest owner and follow its links for lower-level detail.

Find Agent Notes by searching their lifecycle and class directories using the [naming and discovery rules](../.agents/notes/README.md#paths-and-discovery). This guide does not maintain a separate note index.
