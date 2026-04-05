# QwenCode

QwenCode is a local compatibility layer that lets [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) talk to an Ollama-hosted Qwen model instead of Anthropic's cloud API.

[Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) is Anthropic's terminal-based AI coding agent. It reads your files, runs shell commands, and edits code through a structured tool-calling protocol. Normally it requires an Anthropic API key and sends your code to the cloud. QwenCode removes both of those requirements by routing the same interface through a local model.

## Why This Exists

Claude Code expects Messages-style request and streaming semantics. Local models exposed through Ollama speak a different protocol and often fail to emit reliable native tool calls under Claude Code's tool-heavy prompt.

QwenCode bridges that gap by:

- exposing a subset of a Messages-style API on localhost
- translating Claude Code requests into Ollama `/api/chat` calls
- translating Ollama responses back into compatible responses and SSE events
- rescuing common coding workflows with verified synthetic Bash tool calls when the model describes an action instead of calling a tool

The result: you keep Claude Code's full interface (file editing, bash commands, tool orchestration) running entirely on your machine with no API key and no per-token cost.

## How QwenCode Compares to Aider and Continue

If you are evaluating local terminal coding agents, you have likely also looked at [Aider](https://aider.chat/) and [Continue](https://www.continue.dev/). Here is how they differ from QwenCode:

**Aider** is its own standalone agent with its own interface, edit formats, and model abstraction layer. It supports many local and cloud models directly. If you want a fully self-contained agent that does not depend on Claude Code, Aider is a reasonable choice. QwenCode is not trying to replace Aider — it is a different bet: you get Claude Code's specific tool-calling loop and interface, running against a local model instead.

**Continue** is primarily an IDE extension (VS Code, JetBrains) rather than a terminal agent. It integrates local models into your editor's chat and autocomplete. If you prefer staying inside your editor, Continue covers that use case. QwenCode is terminal-first and does not require an IDE.

**QwenCode's specific tradeoff:** You are preserving Claude Code's exact agent loop — its tool orchestration, file-editing protocol, and bash execution flow — while replacing only the backend. This means:

- You get Claude Code's structured tool use rather than a different agent's edit conventions
- The synthetic fallback layer means more of Claude Code's workflows succeed even when the local model does not emit a native tool call
- Post-execution verification means file operations are confirmed correct rather than silently assumed
- There is no separate CLI to learn; if you already use Claude Code, the interface is identical

The honest limitation: Claude Code is the dependency. QwenCode does not work without it, and local model tool-calling is still less reliable than Claude-hosted models. Aider's own model abstraction may be more forgiving of model-specific quirks if you plan to switch models frequently. QwenCode is optimized specifically for Qwen models running through Ollama under Claude Code's protocol.

## Platform Support

QwenCode runs on **Windows**, **macOS**, and **Linux**. The shim itself is plain Node.js with zero dependencies.

| Platform | Shim Launcher | Client Launcher |
|----------|--------------|-----------------|
| Windows  | `launch-shim.ps1` | `launch-client.ps1` |
| macOS    | `launch-shim.sh`  | `launch-client.sh`  |
| Linux    | `launch-shim.sh`  | `launch-client.sh`  |

On macOS/Linux, make the scripts executable after cloning:

```bash
chmod +x launch-shim.sh launch-client.sh
```

## Runtime Requirements

- Node.js 18+
- Ollama running locally (or on a reachable host)
- A Qwen-compatible model pulled in Ollama
- Claude Code installed and runnable as `claude`
- On Windows, a working `bash` executable in PATH for synthetic Bash tool execution (Git Bash or WSL work)

Recommended model: **`qwen2.5-coder:14b`** (default in the launchers). This performed better for constrained coding tasks than larger general-purpose models in testing.

## Quick Start

### 1. Pull the model

```bash
ollama pull qwen2.5-coder:14b
```

### 2. Clone and install

```bash
git clone https://github.com/strifero/QwenCode.git
cd QwenCode
```

No `npm install` needed. Zero dependencies.

### 3. Start the shim

**macOS / Linux:**
```bash
./launch-shim.sh
```

**Windows (PowerShell):**
```powershell
.\launch-shim.ps1
```

### 4. Launch Claude Code against it

In a second terminal:

**macOS / Linux:**
```bash
./launch-client.sh
```

**Windows (PowerShell):**
```powershell
.\launch-client.ps1
```

You can pass Claude Code arguments through:

```bash
./launch-client.sh -- --dangerously-skip-permissions
```

## Performance Expectations

QwenCode adds minimal overhead. The shim itself is a thin translation layer. What you will notice is that **local model inference is slower than the Anthropic API**.

Rough expectations with `qwen2.5-coder:14b`:

| Hardware | First token | Throughput | Practical feel |
|----------|------------|------------|----------------|
| RTX 3060 (12GB) | 2-4s | ~25 tok/s | Usable for focused tasks |
| RTX 4070 (12GB) | 1-3s | ~35 tok/s | Comfortable daily driver |
| RTX 4090 (24GB) | <1s | ~50 tok/s | Near-cloud feel |
| M2 Pro (16GB) | 2-5s | ~20 tok/s | Usable, patience helps |
| CPU only | 10-30s | ~3 tok/s | Not recommended |

The main latency you will feel is on the first response of each turn, because Claude Code's system prompt is large and the model must process it. Subsequent exchanges in the same session are faster.

For comparison, native Claude Code against the Anthropic API typically responds in under 2 seconds with throughput limited only by network speed.

## Claude Code Compatibility

QwenCode is built and tested against **Claude Code CLI** (the `claude` command).

**Tested with:** Claude Code versions available as of April 2026. The shim translates the Messages API format and tool-calling protocol, which has been stable across Claude Code releases.

**What could break:** If Anthropic changes Claude Code's internal API contract (new required fields, new tool formats, new streaming event types), the shim may need updates. The test suite is designed to catch these regressions.

**What is not supported:**
- Multimodal content (image uploads)
- Provider-specific beta features
- Extended thinking / streaming thinking blocks
- MCP server passthrough from Claude Code

## How Synthetic Fallback Works

The most common failure mode with local models is: Claude Code asks the model to call a tool, and instead the model writes out what it *would* do in plain text. For example, instead of calling the `Write` tool, the model says "I'll create a file called `app.py` with the following content..."

QwenCode handles this with a synthetic fallback layer:

1. **Intent parsing.** When the model returns text instead of a tool call, the shim parses the text against a set of known intent patterns (create file, read file, append, replace, insert, delete, rename, create directory, list directory, multi-file scaffold).

2. **Command synthesis.** If a pattern matches, the shim builds the equivalent bash command using `perl` for content injection and verification. Content is passed through environment variables, never interpolated into the command string.

3. **Post-execution verification.** After every synthetic file operation, the shim runs a verification step:
   - **Create/write:** Reads the file back and compares byte-for-byte against expected content
   - **Append:** Verifies the appended text appears in the file
   - **Replace:** Verifies the new string is present and the old string is gone
   - **Insert:** Verifies the combined anchor+insertion text appears in the file
   - **Delete:** Verifies the file no longer exists
   - **Rename:** Verifies the source is gone and the destination exists

4. **Failure on mismatch.** If verification fails, the shim returns a non-zero exit code with a specific error (e.g., `verification failed: create`, exit 91). It never silently claims success.

## When Things Go Wrong

QwenCode handles upstream failures gracefully:

| Failure | What happens |
|---------|-------------|
| Ollama is unreachable | Returns a 502 error with the upstream error message |
| Ollama request times out | Returns a 504 with timeout details (default: 120s, configurable) |
| Model returns malformed JSON | Returns a 502 "invalid upstream response" error |
| Streaming is interrupted mid-response | Cancels the upstream request, closes the SSE stream cleanly |
| Model ignores tool calls entirely | Falls back to text-only response (no crash, no loop) |
| Model's tool call has malformed arguments | Coerces arguments to a valid object; proceeds rather than crashing |
| Synthetic fallback verification fails | Returns the verification error; Claude Code sees a failed tool result and can retry |
| Client disconnects mid-stream | Upstream request is cancelled, resources are cleaned up |
| Request body exceeds 50MB | Returns 413 immediately |

The shim never retries automatically. If something fails, it surfaces the error clearly and lets Claude Code decide what to do next.

## Core Capabilities

### API compatibility

The shim supports:

- `POST /v1/messages` (streaming and non-streaming)
- `GET /v1/models`
- `GET /health`

### Message translation

- `system` + `messages` array
- `text`, `tool_use`, and `tool_result` content blocks
- Usage fields and stop reasons
- Ollama tool calls mapped back to `tool_use` blocks

### Synthetic fallback operations

- Create file / overwrite file / read file
- Append text / replace exact string
- Insert text before or after an exact string
- Rename or move file / delete file
- Create directory / list directory
- Multi-file scaffold from a fenced bash script

### Reliability features

- Upstream request timeout handling (configurable)
- Malformed upstream JSON handling
- Interrupted-stream cancellation with cleanup
- Rate-limit error mapping
- Binary file detection for reads
- Large-file truncation (configurable)
- Client disconnect detection and upstream cancellation
- Continuation-turn handling
- Large-context conversation handling

## Supported Workflow Profile

QwenCode is strongest when the request is explicit and operationally narrow.

**Works well:**
- "create a file called `x` with the text `y`"
- "append `y` to `x`"
- "replace the exact string `a` with `b` in `x`"
- "insert `y` after `x` in file `z`"
- "create a Python script and a README for a demo app"
- "read `package.json` and summarize it"
- "what files are in this directory?"

**Still weaker:**
- Broad open-ended refactors across many files
- Complicated multi-file architectural edits from vague prose
- Tasks where the model must choose many precise tool calls without rescue

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind host |
| `PORT` | `8000` | Bind port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5-coder:14b` | Model name |
| `OLLAMA_AUTH_TOKEN` | | Optional bearer token for Ollama gateways |
| `OLLAMA_NUM_CTX` | | Context window override |
| `SHIM_MAX_TOOLS` | `8` | Max tools forwarded to the model |
| `SHIM_API_KEY` | | Optional shared secret |
| `SHIM_USE_REQUESTED_MODEL` | | Honor incoming model field instead of forcing `OLLAMA_MODEL` |
| `SHIM_LOG` | `info` | Set to `debug` for verbose logging |
| `SHIM_MAX_READ_BYTES` | `200000` | Max bytes for synthetic file reads |
| `SHIM_REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |

## Project Layout

```
QwenCode/
├── src/
│   └── server.mjs          # The entire shim (single file, zero dependencies)
├── scripts/
│   ├── smoke-tests.mjs      # Happy-path integration tests
│   ├── error-smoke-tests.mjs # Error/reliability tests
│   └── mock-ollama.mjs      # Mock upstream for error tests
├── launch-shim.ps1          # Windows shim launcher
├── launch-shim.sh           # macOS/Linux shim launcher
├── launch-client.ps1        # Windows client launcher
├── launch-client.sh         # macOS/Linux client launcher
├── package.json
├── LICENSE                  # MIT
└── README.md
```

## Tests

### Happy-path smoke tests

`npm run smoke` exercises the live shim against a real Ollama backend and validates: create, append, replace, multiline content preservation, empty-string replace, binary reads, large-file truncation, directory creation, nested file creation, unicode content, rename, streaming text, streaming tool use, and continuation-turn fallback behavior.

### Error-path smoke tests

`npm run smoke:error` uses a mock Ollama server to simulate bad upstream behavior and validates: request timeouts, malformed JSON, malformed streaming output, interrupted streaming cancellation, rate limits, fenced multi-file scaffold rescue, and large-context continuation behavior.

Both test suites are self-contained and use a local `.tmp-smoke` folder.

## Limitations

This is not a full Anthropic API implementation. It supports the subset needed to make Claude Code work against a local Qwen backend.

- Native model tool-calling is still less reliable than Claude-hosted models
- Many successful flows depend on synthetic Bash fallback
- Broad open-ended editing is less trustworthy than constrained edits
- Multimodal content and provider-specific beta features are not supported
- Claude Code's system prompt is large, so local latency is noticeable even with a fast GPU
- Claude Code must be installed separately; QwenCode does not work without it

## Changelog

Project history and release notes are tracked via [GitHub releases](https://github.com/strifero/QwenCode/releases) and the [commit log](https://github.com/strifero/QwenCode/commits/main). Check there to see what has changed and when.

## Support

- **Bug reports and feature requests:** [GitHub Issues](https://github.com/strifero/QwenCode/issues)
- **Questions:** Open a [Discussion](https://github.com/strifero/QwenCode/discussions) or file an issue

## License

MIT. See [LICENSE](./LICENSE).

---

Built by [Strife Technologies](https://strifetech.com)