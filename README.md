# fosil

Fosil is a local, inspectable coding agent for a single developer. It runs coding tasks inside a trusted Linux workspace, uses DeepSeek's Responses API for model execution, and keeps the conversation, tool activity, approvals, measurements, and failures in a durable local event history.

Document type: reference.

The product combines a Simplified Chinese browser interface with an event-driven agent loop, approved file and shell tools, automatic context compaction, and a detailed execution trace. It is designed for local use and transparent inspection rather than remote or multi-user deployment.

## Highlights

- **Chat and Trace views:** follow streamed answers in Chat, then inspect the exact model requests, tool calls, approvals, timings, usage, errors, and retained file-change evidence in Trace.
- **Durable execution history:** sessions and canonical execution events are stored in SQLite, allowing completed conversations and traces to be reopened after a browser refresh or service restart.
- **Controlled local tools:** the agent can inspect repositories, read and edit files, and run shell commands. Each run uses `Read Only`, `Workspace Write`, or `Full Access`, with explicit allow-once approval for gated operations.
- **Context management:** request-level context composition and automatic compaction keep long sessions usable without rewriting or deleting their original event history.
- **Local data boundaries:** the service listens only on IPv4 loopback, masks configured secret values before persistence, bounds retained payloads and browser projections, and does not upload traces by default.
- **Evidence-backed verification:** deterministic tests cover the agent loop, storage, tools, HTTP/SSE, Chat, Trace, recovery, failure paths, and real-browser behavior without spending provider tokens. A separately gated live release procedure verifies the complete DeepSeek workflow.

## Requirements

- Linux, including Linux under WSL2. Native Windows and macOS are not currently verified.
- Node.js 24 and npm. The repository's [`.nvmrc`](.nvmrc) records the supported major version.
- Network access to the official DeepSeek API when running model-backed tasks.
- A DeepSeek API key, supplied through `DEEPSEEK_API_KEY` or entered in the WebUI after startup. The service can start without a key, but model dispatch remains unavailable until one is configured.

Fosil executes commands on the host and its approval controls are not an operating-system sandbox. Use it only with workspaces and tasks you trust.

## Run locally

Install the locked dependency graph from the repository root:

```sh
npm ci
```

Start the application:

```sh
npm start
```

`npm start` builds all packages and the Web application before launching the local service. Open [http://127.0.0.1:7860](http://127.0.0.1:7860), configure a DeepSeek API key in Settings if one was not supplied through the environment, and select an existing workspace using its absolute Linux path.

To configure the provider key through the environment instead, use a nonfunctional placeholder and keep the real value out of tracked files:

```sh
export DEEPSEEK_API_KEY="your-key-here"
npm start
```

The default launcher uses `.fosil/events.db`, port `7860`, and `deepseek-v4-flash`. Common overrides are available through launcher options:

```sh
npm start -- --database .fosil/events.db --port 7860 --model deepseek-v4-pro
npm start -- --help
```

After the browser opens:

1. Choose an existing local repository or directory as the workspace.
2. Create a conversation and describe a concrete coding task.
3. Select the run's access mode and submit the message.
4. Review any gated tool operation before allowing or denying it.
5. Inspect the result in Chat and the correlated execution evidence in Trace.

The API key entered in the WebUI remains in process memory only and must be configured again after a restart. Launcher options, model behavior, masking, and provider failure boundaries are documented in the [DeepSeek provider reference](docs/deepseek-provider.md).

## Architecture

Fosil is an npm workspace with strict TypeScript and ESM boundaries. The runtime follows this high-level flow:

```text
Browser: Chat and Trace
          |
          | loopback HTTP and SSE
          v
Server: commands, agent loop, masking, and recovery
          |                    |                    |
          v                    v                    v
DeepSeek Responses API   Approved local tools   Storage worker
                                                  |
                                                  v
                                           SQLite event ledger
```

| Package | Responsibility |
| --- | --- |
| [`@fosil/contracts`](packages/contracts/) | JSON-safe schemas and shared TypeScript contracts for events, commands, tools, and browser projections. |
| [`@fosil/core`](packages/core/) | Pure event reduction, recovery planning, history projection, and provider-neutral request assembly. |
| [`@fosil/server`](packages/server/) | SQLite ownership, agent-loop orchestration, approved tools, DeepSeek translation, context compaction, local HTTP/SSE, and product startup. |
| [`@fosil/web`](packages/web/) | The React Chat and Trace interface, session controls, approvals, cancellation, runtime credential configuration, and live event projection. |
| [`@fosil/acceptance`](packages/acceptance/) | Controlled and live acceptance drivers plus inspectable verification reports. |

Shared contracts validate every runtime boundary. The event ledger is the persistent source of truth, while the browser receives bounded projections over HTTP and SSE. Tool execution and provider I/O remain in the server; replaying history never repeats either effect. See the [architecture reference](docs/architecture.md) for the complete dependency and responsibility boundaries.

## Development and verification

Install the Chromium runtime used by real-browser tests, then run the repository checks:

```sh
npx playwright install chromium
npm run typecheck
npm run build
npm test
npm run sqlite:probe
npm start -- --help
```

These checks do not require provider credentials and do not make billable model requests. The [development guide](docs/development.md) owns the complete command reference, focused test syntax, WSL notes, and verification expectations. Live provider acceptance is intentionally separate because it requires an explicit `--live` gate, a credential, network access, and billable DeepSeek requests; follow the [first-release acceptance procedure](docs/release-acceptance.md) before running it.

## Current scope and limitations

Fosil's first release targets one developer, one local service, one active agent, and trusted local repositories. It does not currently provide multi-user or remote hosting, multi-agent delegation, MCP or plugins, scheduled tasks, IDE integration, cloud telemetry, or multiple production model providers.

Refreshing the browser or reopening completed history does not repeat model or tool activity. After a service crash or restart, interrupted external effects are recorded as uncertain rather than resumed automatically; the user must inspect and acknowledge the workspace state before continuing where required. Secret masking covers values explicitly configured with the service, not arbitrary credentials already embedded in source files or tool output.

The approved workflow, exclusions, safety boundaries, and acceptance conditions are defined in the [first-release product scope](docs/product-scope.md).

## Documentation

- [Documentation guide](docs/README.md): find the document that owns a topic.
- [Architecture](docs/architecture.md): understand package composition and runtime boundaries.
- [Chat controls](docs/chat-controls.md): learn the browser conversation workflow and approval behavior.
- [Trace inspector](docs/trace-inspector.md): understand execution correlation and evidence presentation.
- [Context compaction](docs/context-compaction.md): review long-session measurement and recovery behavior.
- [Development guide](docs/development.md): set up, verify, and maintain the repository.
- [Agent instructions](AGENTS.md): read repository-wide requirements before making changes.
- [Agent Notes](.agents/notes/README.md): consult implemented decisions and their trade-offs.
