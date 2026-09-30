# Shouldertap

A trusted person can send a message that appears across your connected computer displays until you acknowledge it, then receive your response.

## Project document

[Shouldertap: app idea](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the project's source of truth for the concept, proposed core flow, feature ideas, open questions, and initial technical sketch.

Use **Shouldertap** as the project name. Product scope and architecture are still being explored in the Notion document.

## Workspace

Local project: `/Users/jakebodea/code/projects/shouldertap`.

This workspace currently contains project documentation; implementation has not started here.

## Architecture planning

The selected client direction is React Native macOS with a small Apple-specific module, a Safari sender for v0, and a future Expo iPhone/iPad companion. The proposed backend uses Cloudflare Workers, Durable Objects, D1, Effect, and Alchemy, with Better T Stack and Ultracite for the workspace foundation.

- [Architecture plan](docs/architecture.md)
- [Apple client research](docs/research/apple-clients.md)
- [Backend and tooling research](docs/research/backend-stack.md)
