# fosil

A coding agent project developed by a single maintainer.

Document type: reference.

The current implementation provides a controlled-provider agent loop over durable events and approved file and shell tools, a local HTTP/SSE service, and product [Chat controls](docs/chat-controls.md) for saved sessions, streaming, approvals, and cancellation. Trace inspection, a product launcher, and real-provider integration remain unfinished. See the [architecture reference](docs/architecture.md) for implemented boundaries.

## Start here

- [First-release scope](docs/product-scope.md): the approved workflow, trace requirements, and acceptance conditions.
- [Execution Foundation acceptance](docs/execution-foundation-acceptance.md): reproduce and inspect the checkpoint's execution evidence.
- [Agent Loop acceptance](docs/agent-loop-acceptance.md): inspect a controlled-provider repair through the production loop.
- [Documentation guide](docs/README.md): find the document that owns a topic.
- [Development guide](docs/development.md): follow the working and verification process.
- [Agent instructions](AGENTS.md): read the repository-wide instructions before making changes.
- [Agent Notes](.agents/notes/README.md): record and consult decisions and their trade-offs.
