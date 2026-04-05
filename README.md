# QwenCode

QwenCode is a local compatibility layer that lets Claude Code talk to an Ollama-hosted Qwen model.

It exists because Claude Code expects Messages-style request and streaming semantics, while local models exposed through Ollama usually speak a different protocol and often do not emit reliable native tool calls under a tool-heavy coding prompt.

QwenCode bridges that gap by:

- exposing a subset of a Messages-style API
- translating Claude Code requests into Ollama `/api/chat` calls
- translating Ollama responses back into compatible responses and SSE events
- rescuing common coding workflows with verified synthetic Bash tool calls when the model describes an action instead of calling a tool

## What This Project Is

This packaged project lives independently in this folder and contains only the files needed to:

- run the shim
- launch Claude Code against it
- run happy-path smoke tests
- run mock-based error and reliability tests

## Project Layout

```text
QwenCode/
├─ src/
│  └─ server.mjs
├─ scripts/
│  ├─ smoke-tests.mjs
│  ├─ error-smoke-tests.mjs
│  └─ mock-ollama.mjs
├─ launch-shim.ps1
├─ launch-client.ps1
├─ package.json
├─ .gitignore
└─ README.md
```

## Core Capabilities

### API compatibility

The shim supports:

- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`
- non-streaming compatible message responses
- streaming SSE responses with compatible lifecycle events

### Message translation

The shim translates:

- `system` + `messages`
- `text`, `tool_use`, and `tool_result` blocks
- usage fields and stop reasons
- Ollama tool calls into compatible `tool_use` blocks

### Synthetic fallback layer

When Qwen returns text that describes an action instead of calling a tool, QwenCode can synthesize a verified `Bash` tool call for explicit, high-confidence tasks.

Current supported synthetic workflows include:

- create file
- overwrite file
- read file
- append text
- replace exact string
- insert text before an exact string
- insert text after an exact string
- rename or move file
- delete file
- create directory
- list directory
- safe multi-file scaffold from a fenced bash script

Synthetic file operations are verified after execution so the shim does not silently claim success.

### Reliability features

The shim includes:

- upstream request timeout handling
- malformed upstream JSON handling
- malformed upstream streaming handling
- interrupted-stream cancellation
- rate-limit error mapping
- binary file detection for reads
- large-file truncation
- continuation-turn handling when tool results and fresh user text arrive together
- large-context conversation handling

## Why It Works

Claude Code is already good at orchestrating tools, permissions, and user interaction. The problem is that local models often fail to follow the exact tool-calling contract Claude Code expects.

QwenCode keeps Claude Code unchanged and makes the backend behave more like what Claude Code expects.

The strategy is:

1. keep Claude Code as the frontend
2. keep Ollama/Qwen as the backend
3. translate protocols in the middle
4. patch the most common failure mode with narrowly-scoped synthetic tool fallbacks

That gives you a local coding agent experience without changing Claude Code itself.

## Runtime Requirements

- Node.js 18+
- Ollama
- A Qwen-compatible model available in Ollama
- Claude Code installed and runnable as `claude`
- On Windows, a working `bash` executable in PATH for synthetic Bash tool execution

Recommended local model:

- `qwen2.5-coder:14b`

This is the current default in the launcher because it performed better for constrained coding tasks than the earlier general-purpose Qwen 3.5 test path.

## Configuration

The server reads these environment variables:

- `HOST`
  - Bind host for the shim
  - Default: `127.0.0.1`
- `PORT`
  - Port for the shim
  - Default: `8000`
- `OLLAMA_BASE_URL`
  - Base URL for Ollama
  - Default: `http://127.0.0.1:11434`
- `OLLAMA_MODEL`
  - Model name to send to Ollama
  - Default in launcher: `qwen2.5-coder:14b`
- `OLLAMA_AUTH_TOKEN`
  - Optional bearer token for Ollama-compatible gateways
- `OLLAMA_NUM_CTX`
  - Optional context window override passed as `options.num_ctx`
- `SHIM_MAX_TOOLS`
  - Maximum number of forwarded tools
- `SHIM_API_KEY`
  - Optional shared secret for shim requests
- `SHIM_USE_REQUESTED_MODEL`
  - If `true`, honor the incoming requested `model` instead of forcing `OLLAMA_MODEL`
- `SHIM_LOG`
  - `debug` enables verbose logging
- `SHIM_MAX_READ_BYTES`
  - Maximum bytes returned by synthetic file reads before truncation
- `SHIM_REQUEST_TIMEOUT_MS`
  - Timeout for upstream requests

## Launching

### Start the shim

```powershell
.\launch-shim.ps1
```

Default launcher values:

- Ollama base URL: `http://127.0.0.1:11434`
- Ollama model: `qwen2.5-coder:14b`
- max tools: `26`
- log level: `debug`

### Launch Claude Code against the shim

```powershell
.\launch-client.ps1
```

This sets:

- `ANTHROPIC_BASE_URL=http://127.0.0.1:8000`
- `ANTHROPIC_API_KEY=dummy`
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`

You can also pass through Claude Code arguments:

```powershell
.\launch-client.ps1 -- --dangerously-skip-permissions
```

## NPM Scripts

```bash
npm start
npm run smoke
npm run smoke:error
```

## Tests

### Happy-path smoke tests

`scripts/smoke-tests.mjs` exercises the live shim against a real backend and validates:

- create / append / replace
- multiline content preservation
- empty-string replace
- binary reads
- large-file truncation
- directory creation
- nested file creation
- unicode content
- rename
- streaming text
- streaming tool use
- continuation-turn fallback behavior

### Error-path smoke tests

`scripts/error-smoke-tests.mjs` uses `scripts/mock-ollama.mjs` to simulate bad upstream behavior and validates:

- request timeouts
- malformed JSON
- malformed streaming output
- interrupted streaming cancellation
- rate limits
- fenced multi-file scaffold rescue
- large-context continuation behavior

Both test suites are self-contained and use a local `.tmp-smoke` folder under the project root.

## Supported Workflow Profile

QwenCode is strongest today when the request is explicit and operationally narrow.

Examples that work well:

- "create a file called `x` with the text `y`"
- "append `y` to `x`"
- "replace the exact string `a` with `b` in `x`"
- "insert `y` after `x` in file `z`"
- "create a Python script and a README for a demo app"
- "read `package.json` and summarize it"
- "what files are in this directory?"

Examples that are still weaker:

- broad open-ended refactors
- complicated multi-file architectural edits from vague prose
- tasks where the model must choose many precise tool calls without rescue

## Limitations

This is not a full protocol implementation. It intentionally supports the subset needed to make Claude Code usable against a local Qwen backend.

Known limitations:

- native model tool-calling is still less reliable than Claude-hosted models
- many successful flows still depend on synthetic Bash fallback
- broad open-ended editing is less trustworthy than constrained edits
- multimodal content, uploads, and provider-specific beta features are not implemented
- the Claude Code prompt is still large, so local latency can remain noticeable even with a good model

## Recommended Usage

If you want the best current experience:

1. run a local Ollama instance
2. use `qwen2.5-coder:14b`
3. keep `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
4. use the shim for constrained coding operations first
5. run the smoke tests whenever you make changes

## Development Notes

The most important file is:

- `src/server.mjs`

That file contains:

- request translation
- compatible response formatting
- SSE handling
- synthetic fallback parsing
- verification logic
- upstream timeout and disconnect handling

The project is intentionally small and dependency-light so it is easy to understand and change.
