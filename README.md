# fosil

A coding agent project developed by a single maintainer.

Document type: reference.

The current implementation provides an agent loop over durable events and approved file and shell tools, a loopback HTTP/SSE service, product [Chat controls](docs/chat-controls.md), a correlated [Trace inspector](docs/trace-inspector.md), and a local launcher for the [DeepSeek Responses provider](docs/deepseek-provider.md) with [automatic context compaction](docs/context-compaction.md). Configured-secret masking, bounded browser projections, and per-session retained-payload budgets apply at the local data boundary. Live provider acceptance remains unfinished. See the [architecture reference](docs/architecture.md) for package boundaries.

## Start here

- [First-release scope](docs/product-scope.md): the approved workflow, trace requirements, and acceptance conditions.
- [Execution Foundation acceptance](docs/execution-foundation-acceptance.md): reproduce and inspect the checkpoint's execution evidence.
- [Agent Loop acceptance](docs/agent-loop-acceptance.md): inspect a controlled-provider repair through the production loop.
- [Documentation guide](docs/README.md): find the document that owns a topic.
- [Development guide](docs/development.md): follow the working and verification process.
- [Agent instructions](AGENTS.md): read the repository-wide instructions before making changes.
- [Agent Notes](.agents/notes/README.md): record and consult decisions and their trade-offs.
