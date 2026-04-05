import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024
const MAX_UPSTREAM_STREAM_LINE_BYTES = 16 * 1024 * 1024

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parseIntWithDefault(process.env.PORT, 8000),
  ollamaBaseUrl: (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b',
  ollamaAuthToken: process.env.OLLAMA_AUTH_TOKEN || '',
  ollamaNumCtx: parseOptionalInt(process.env.OLLAMA_NUM_CTX),
  maxTools: parseIntWithDefault(process.env.SHIM_MAX_TOOLS, 8),
  shimApiKey: process.env.SHIM_API_KEY || '',
  useRequestedModel: isTruthy(process.env.SHIM_USE_REQUESTED_MODEL),
  logLevel: process.env.SHIM_LOG || 'info',
  maxReadBytes: parseIntWithDefault(process.env.SHIM_MAX_READ_BYTES, 200000),
  requestTimeoutMs: parseIntWithDefault(process.env.SHIM_REQUEST_TIMEOUT_MS, 120000),
  allowCorsWildcard: isTruthy(process.env.SHIM_ALLOW_CORS_WILDCARD),
}

function sanitizeUpstreamUrl(value) {
  if (!value) return ''
  try {
    const parsed = new URL(value)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return String(value).replace(/\/\/[^/@\s]*@/, '//')
  }
}

function isTruthy(value) {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function parseOptionalInt(value) {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseIntWithDefault(value, fallback) {
  if (value == null || value === '') return fallback
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function logDebug(...args) {
  if (config.logLevel === 'debug') console.error('[shim]', ...args)
}

function summarizeToolNames(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return []
  return tools.map(tool => tool?.function?.name || tool?.name || 'unknown').filter(Boolean)
}

function stripWrappedText(value) {
  const text = String(value || '').trim()
  if (!text) return text
  const pairs = [['"', '"'], ["'", "'"], ['`', '`']]
  for (const [start, end] of pairs) {
    if (text.startsWith(start) && text.endsWith(end) && text.length >= 2) return text.slice(1, -1)
  }
  return text
}

function firstDefinedString(...values) {
  for (const value of values) { if (typeof value === 'string') return value }
  return ''
}

function stripSystemReminderBlocks(text) {
  return String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ').trim()
}

function normalizeInlineWhitespace(text) {
  return String(text || '').trim().replace(/\s+/g, ' ')
}

function getTextFromContentBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyContent(content)
  return content.map(block => {
    if (typeof block === 'string') return block
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    return ''
  }).filter(Boolean).join('\n')
}

function getLatestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (Array.isArray(message.content)) {
      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
        const block = message.content[blockIndex]
        if (block?.type !== 'text' || typeof block.text !== 'string') continue
        const stripped = stripSystemReminderBlocks(block.text)
        if (stripped) return stripped
      }
    }
    const text = stripSystemReminderBlocks(getTextFromContentBlocks(message.content))
    if (text) return text
  }
  return ''
}

function getLatestUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index]
  }
  return null
}

function latestUserTurnIsToolResultContinuation(messages) {
  const message = getLatestUserMessage(messages)
  if (!Array.isArray(message?.content)) return false
  const hasToolResult = message.content.some(block => block?.type === 'tool_result')
  if (!hasToolResult) return false
  const hasFreeformUserText = message.content.some(block =>
    block?.type === 'text' && typeof block.text === 'string' && stripSystemReminderBlocks(block.text).trim().length > 0
  )
  return !hasFreeformUserText
}

function maybeParseCreateFileIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const match = rawText.match(/^create\s+a\s+file\s+(?:called|named)\s+(.+?)\s+(?:with\s+(?:the\s+)?text|containing(?:\s+exactly)?|whose contents should be)\s+([\s\S]*)$/i)
  if (!match) return null
  const fileName = stripWrappedText(match[1])
  const content = stripWrappedText(match[2])
  if (!fileName) return null
  if (/[\r\n]/.test(fileName)) return null
  if (fileName.includes('*')) return null
  return { fileName, content }
}

function maybeParseWriteFileIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const writeMatch = rawText.match(/^(?:please\s+)?write\s+(?:the\s+text\s+)?([\s\S]*?)\s+to\s+(?:the\s+file\s+)?(.+)$/i)
  if (writeMatch) {
    const content = stripWrappedText(writeMatch[1])
    const filePath = stripWrappedText(writeMatch[2])
    if (filePath && isLikelyPathToken(filePath)) return { filePath, content }
  }
  const overwriteMatch = rawText.match(/^(?:please\s+)?overwrite\s+(?:the\s+file\s+)?(.+?)\s+with\s+(?:the\s+text\s+)?([\s\S]*)$/i)
  if (overwriteMatch) {
    const filePath = stripWrappedText(overwriteMatch[1])
    const content = stripWrappedText(overwriteMatch[2])
    if (filePath && isLikelyPathToken(filePath)) return { filePath, content }
  }
  const setContentsMatch = rawText.match(/^(?:please\s+)?set\s+(?:the\s+)?contents\s+of\s+(?:the\s+file\s+)?(.+?)\s+to\s+([\s\S]*)$/i)
  if (setContentsMatch) {
    const filePath = stripWrappedText(setContentsMatch[1])
    const content = stripWrappedText(setContentsMatch[2])
    if (filePath && isLikelyPathToken(filePath)) return { filePath, content }
  }
  return null
}

function isLikelyPathToken(token) {
  if (!token) return false
  if (/\s/.test(token)) return false
  if (/[<>|?*]/.test(token)) return false
  if (/[\\\/]/.test(token)) return true
  return /\.[A-Za-z0-9._-]+$/.test(token)
}

function stripTrailingPunctuation(value) {
  return String(value || '').replace(/[.,;:!?]+$/, '').trim()
}

function extractQuotedOrBarePath(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const quoted = text.match(/^(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s*$/)
  if (quoted) return firstDefinedString(quoted[1], quoted[2], quoted[3])
  const stripped = stripTrailingPunctuation(text)
  return isLikelyPathToken(stripped) ? stripped : ''
}

function extractPathCandidate(text) {
  const wrappedPatterns = [/`([^`]+)`/, /"([^"]+)"/, /'([^']+)'/]
  for (const pattern of wrappedPatterns) {
    const match = String(text || '').match(pattern)
    const value = stripWrappedText(match?.[1] || '')
    if (isLikelyPathToken(value)) return value
  }
  const tokenPattern = /(?:^|\s)([A-Za-z]:[\\\/][^\s"'`]+|\.{1,2}[\\\/][^\s"'`]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9._-]+)(?=$|\s)/g
  const matches = [...String(text || '').matchAll(tokenPattern)]
  for (const match of matches) {
    const value = stripWrappedText(match[1] || '')
    if (isLikelyPathToken(value)) return value
  }
  return ''
}

function maybeParseListDirectoryIntent(userText) {
  const normalized = normalizeInlineWhitespace(userText).toLowerCase()
  if (!normalized) return false
  return [
    /what files are in (?:this|the current) (?:dir|directory)/,
    /what(?:'s| is) in (?:this|the current) (?:dir|directory)/,
    /list (?:all )?(?:the )?files(?: in (?:this|the current) (?:dir|directory))?/,
    /show (?:me )?(?:all )?(?:the )?(?:files|contents)(?: of| in)? (?:this|the current) (?:dir|directory)/,
    /list files in directory/,
  ].some(pattern => pattern.test(normalized))
}

function maybeParseReadFileIntent(userText) {
  const normalized = normalizeInlineWhitespace(userText)
  const lower = normalized.toLowerCase()
  if (!normalized) return null
  const startsWithStrictReadVerb = /^(?:please\s+)?(?:read|open|show|view|display|cat|inspect)\b/i.test(normalized)
  const startsWithSummarizeVerb = /^(?:please\s+)?(?:summari[sz]e|explain)\b/i.test(normalized)
  if (!startsWithStrictReadVerb && !startsWithSummarizeVerb) return null
  if (/\b(add|modify|edit|write|create|append|delete|remove|replace|change)\b/i.test(lower)) return null
  if (startsWithSummarizeVerb) {
    const hasQuotedPath = /(`[^`]+`|"[^"]+"|'[^']+')/.test(normalized)
    if (!hasQuotedPath) return null
  }
  const filePath = extractPathCandidate(normalized)
  if (!filePath) return null
  return { filePath }
}

function maybeParseAppendIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const match = rawText.match(/^(?:please\s+)?append\s+(?:the\s+text\s+)?([\s\S]*?)\s+to\s+(?:the\s+file\s+)?(.+)$/i)
  if (!match) return null
  const content = stripWrappedText(match[1])
  const filePath = stripWrappedText(match[2])
  if (!content || !filePath) return null
  if (!isLikelyPathToken(filePath)) return null
  return { filePath, content }
}

function maybeParseReplaceIntent(userText) {
  if (!userText) return null
  const wrapped = String(userText).match(
    /replace\s+(?:the\s+exact\s+string\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+with\s+(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s+in\s+(?:the\s+file\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z]:[\\\/][^\s"'`]+|\.{1,2}[\\\/][^\s"'`]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9._-]+))/i,
  ) || []
  const oldString = firstDefinedString(wrapped[1], wrapped[2], wrapped[3])
  const newString = firstDefinedString(wrapped[4], wrapped[5], wrapped[6])
  const filePath = stripWrappedText(wrapped[7] || wrapped[8] || wrapped[9] || wrapped[10] || '')
  if (!oldString || !filePath) return null
  if (!isLikelyPathToken(filePath)) return null
  return { filePath, oldString, newString }
}

function maybeParseInsertAfterIntent(userText) {
  if (!userText) return null
  const wrapped = String(userText).match(
    /insert\s+(?:the\s+text\s+)?(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s+after\s+(?:the\s+exact\s+string\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+in\s+(?:the\s+file\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z]:[\\\/][^\s"'`]+|\.{1,2}[\\\/][^\s"'`]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9._-]+))/i,
  ) || []
  const insertText = firstDefinedString(wrapped[1], wrapped[2], wrapped[3])
  const anchor = firstDefinedString(wrapped[4], wrapped[5], wrapped[6])
  const filePath = stripWrappedText(wrapped[7] || wrapped[8] || wrapped[9] || wrapped[10] || '')
  if (!anchor || !filePath) return null
  if (!isLikelyPathToken(filePath)) return null
  return { filePath, anchor, insertText }
}

function maybeParseInsertBeforeIntent(userText) {
  if (!userText) return null
  const wrapped = String(userText).match(
    /insert\s+(?:the\s+text\s+)?(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s+before\s+(?:the\s+exact\s+string\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+in\s+(?:the\s+file\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z]:[\\\/][^\s"'`]+|\.{1,2}[\\\/][^\s"'`]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9._-]+))/i,
  ) || []
  const insertText = firstDefinedString(wrapped[1], wrapped[2], wrapped[3])
  const anchor = firstDefinedString(wrapped[4], wrapped[5], wrapped[6])
  const filePath = stripWrappedText(wrapped[7] || wrapped[8] || wrapped[9] || wrapped[10] || '')
  if (!anchor || !filePath) return null
  if (!isLikelyPathToken(filePath)) return null
  return { filePath, anchor, insertText }
}

function maybeParseDeleteFileIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const match = rawText.match(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+file\s+)?(.+)$/i)
  if (!match) return null
  const filePath = extractQuotedOrBarePath(match[1])
  if (!filePath) return null
  return { filePath }
}

function maybeParseRenameFileIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const match = rawText.match(/^(?:please\s+)?rename\s+(?:the\s+file\s+)?(.+?)\s+to\s+(.+)$/i) ||
    rawText.match(/^(?:please\s+)?move\s+(?:the\s+file\s+)?(.+?)\s+to\s+(.+)$/i)
  if (!match) return null
  const fromPath = extractQuotedOrBarePath(match[1])
  const toPath = extractQuotedOrBarePath(match[2])
  if (!fromPath || !toPath) return null
  return { fromPath, toPath }
}

function maybeParseCreateDirectoryIntent(userText) {
  if (!userText) return null
  const rawText = String(userText).trim()
  const match = rawText.match(/^(?:please\s+)?create\s+(?:a\s+)?(?:directory|folder)\s+(?:called|named)?\s*(.+)$/i) ||
    rawText.match(/^(?:please\s+)?make\s+(?:a\s+)?(?:directory|folder)\s+(?:called|named)?\s*(.+)$/i)
  if (!match) return null
  const rawDir = stripTrailingPunctuation(match[1])
  const quoted = rawDir.match(/^(?:"([^"]+)"|'([^']+)'|`([^`]+)`)$/)
  const dirPath = quoted ? firstDefinedString(quoted[1], quoted[2], quoted[3]) : rawDir
  if (!dirPath) return null
  if (/[<>|?*]/.test(dirPath)) return null
  if (!quoted && /\s/.test(dirPath)) return null
  return { dirPath }
}

function classifyFallbackIntent(userText) {
  if (maybeParseCreateDirectoryIntent(userText)) return 'create_directory'
  if (maybeParseCreateFileIntent(userText)) return 'create_file'
  if (maybeParseWriteFileIntent(userText)) return 'write_file'
  if (maybeParseReadFileIntent(userText)) return 'read_file'
  if (maybeParseAppendIntent(userText)) return 'append_file'
  if (maybeParseReplaceIntent(userText)) return 'replace_file'
  if (maybeParseInsertAfterIntent(userText)) return 'insert_after'
  if (maybeParseInsertBeforeIntent(userText)) return 'insert_before'
  if (maybeParseDeleteFileIntent(userText)) return 'delete_file'
  if (maybeParseRenameFileIntent(userText)) return 'rename_file'
  if (maybeParseListDirectoryIntent(userText)) return 'list_directory'
  const normalized = normalizeInlineWhitespace(userText).toLowerCase()
  if (/\b(find|locate|search|grep|scan)\b/.test(normalized) && /\b(file|files|entrypoint|main|package\.json|readme|src)\b/.test(normalized)) return 'search_files'
  if (/\b(run|execute)\b/.test(normalized)) return 'run_command'
  if (/\b(create|generate|scaffold|build)\b/.test(normalized) && /\b(file|files|script|component|module|readme|utility|project|app)\b/.test(normalized)) return 'scaffold_files'
  return 'none'
}

const KNOWN_SHELL_COMMANDS = new Set(['ls','dir','cat','head','tail','sed','grep','rg','find','pwd','echo','printf','git','npm','bun','node','python','python3','mkdir','cp','mv','rm','touch'])
const SAFE_SCAFFOLD_COMMANDS = new Set(['mkdir','cat','printf','echo','touch','cp','mv'])
const UNSAFE_SCRIPT_PATTERNS = [/\bsudo\b/i, /\bcurl\b/i, /\bwget\b/i, /\bchmod\b/i, /\bchown\b/i, /\bgit\s+push\b/i, /\bgit\s+commit\b/i, /\brm\s+-rf\b/i]

function extractStandaloneCommand(text) {
  if (!text) return ''
  let candidateText = String(text)
  const fenced = candidateText.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i)
  if (fenced?.[1]) candidateText = fenced[1]
  const lines = candidateText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const commandLines = lines
    .map(line => line.replace(/^[*-]\s+/, ''))
    .map(line => line.replace(/[.!?]+$/, '').trim())
    .filter(line => {
      const firstWord = line.split(/\s+/)[0]
      if (!KNOWN_SHELL_COMMANDS.has(firstWord)) return false
      if (line.length > 320) return false
      return true
    })
  if (commandLines.length === 1) return commandLines[0]
  return ''
}

function extractSafeScaffoldScript(text) {
  if (!text) return ''
  let candidateText = String(text)
  const fenced = candidateText.match(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/i)
  if (fenced?.[1]) candidateText = fenced[1]
  if (candidateText.length > 6000) return ''
  if (UNSAFE_SCRIPT_PATTERNS.some(pattern => pattern.test(candidateText))) return ''
  const rawLines = candidateText.split(/\r?\n/)
  const scriptLines = []
  let hereDocTerminator = ''
  let sawCommand = false
  let commandCount = 0
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (hereDocTerminator) {
      scriptLines.push(rawLine)
      if (trimmed === hereDocTerminator) hereDocTerminator = ''
      continue
    }
    if (!trimmed || trimmed.startsWith('#')) {
      if (scriptLines.length > 0) scriptLines.push(rawLine)
      continue
    }
    const normalizedLine = rawLine.replace(/^\s*[*-]\s+/, '')
    const trimmedLine = normalizedLine.trim()
    const firstWord = trimmedLine.split(/\s+/)[0]
    if (!SAFE_SCAFFOLD_COMMANDS.has(firstWord)) return ''
    if (/[;&|]{2,}|`/.test(trimmedLine)) return ''
    const hereDocMatch = trimmedLine.match(/<<-?\s*['"']?([A-Za-z0-9_]+)['"']?\s*$/)
    if (hereDocMatch) hereDocTerminator = hereDocMatch[1]
    sawCommand = true
    commandCount += 1
    scriptLines.push(normalizedLine)
  }
  if (!sawCommand || hereDocTerminator) return ''
  if (commandCount < 2 && !scriptLines.some(line => line.includes('<<'))) return ''
  return scriptLines.join('\n').trim()
}

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function buildCreateFileCommand(fileName, content) {
  return [
    `export TARGET_FILE=${bashSingleQuote(fileName)}`,
    `export EXPECTED_CONTENT=${bashSingleQuote(content)}`,
    'TARGET_DIR=$(dirname -- "$TARGET_FILE")',
    '[ "$TARGET_DIR" = "." ] || mkdir -p -- "$TARGET_DIR"',
    `perl -e 'print $ENV{"EXPECTED_CONTENT"}' > ${bashSingleQuote(fileName)}`,
    `perl -0e 'my $expected = $ENV{"EXPECTED_CONTENT"}; my $actual = do { local (@ARGV, $/) = shift; <> }; exit($actual eq $expected ? 0 : 91)' "$TARGET_FILE" || { echo "verification failed: create" >&2; exit 91; }`,
  ].join('\n')
}

function buildReadFileCommand(filePath) {
  return [
    `export TARGET_FILE=${bashSingleQuote(filePath)}`,
    `export SHIM_MAX_READ_BYTES=${String(config.maxReadBytes)}`,
    "perl -e 'use strict; use warnings; my $file = $ENV{\"TARGET_FILE\"}; my $max = $ENV{\"SHIM_MAX_READ_BYTES\"} || 200000; open my $fh, \"<:raw\", $file or die \"unable to read file\\n\"; read($fh, my $sample, 4096); seek($fh, 0, 0); my $control = ($sample =~ tr/\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F//); my $is_binary = index($sample, \"\\x00\") >= 0 || (length($sample) > 0 && $control / length($sample) > 0.10); if ($is_binary) { print \"[shim] Binary file detected: $file\\n\"; exit 0; } my $size = -s $fh; if (defined($size) && $size > $max) { read($fh, my $content, $max); print \"[shim] File truncated to ${max} bytes: $file\\n\"; print $content; exit 0; } local $/; my $content = <$fh>; print defined($content) ? $content : q{};'",
  ].join('\n')
}

function buildWriteFileCommand(filePath, content) { return buildCreateFileCommand(filePath, content) }

function buildAppendFileCommand(filePath, content) {
  return [
    `export TARGET_FILE=${bashSingleQuote(filePath)}`,
    `export APPEND_TEXT=${bashSingleQuote(content)}`,
    'TARGET_DIR=$(dirname -- "$TARGET_FILE")',
    '[ "$TARGET_DIR" = "." ] || mkdir -p -- "$TARGET_DIR"',
    `perl -e 'print $ENV{"APPEND_TEXT"}' >> ${bashSingleQuote(filePath)}`,
    `perl -0e 'my $needle = $ENV{"APPEND_TEXT"}; my $actual = do { local (@ARGV, $/) = shift; <> }; exit(index($actual, $needle) >= 0 ? 0 : 92)' "$TARGET_FILE" || { echo "verification failed: append" >&2; exit 92; }`,
  ].join('\n')
}

function buildReplaceInFileCommand(filePath, oldString, newString) {
  return [
    `export TARGET_FILE=${bashSingleQuote(filePath)}`,
    `export OLD=${bashSingleQuote(oldString)}`,
    `export NEW=${bashSingleQuote(newString)}`,
    `perl -0pi -e 'BEGIN { $old = $ENV{"OLD"}; $new = $ENV{"NEW"}; } s/\\Q$old\\E/$new/ge or die "pattern not found\\n"' ${bashSingleQuote(filePath)}`,
    `perl -0e 'my $old = $ENV{"OLD"}; my $new = $ENV{"NEW"}; my $actual = do { local (@ARGV, $/) = shift; <> }; if ($old ne $new && length($new) && index($actual, $new) < 0) { exit 93 } if ($old ne $new && length($old) && index($actual, $old) >= 0) { exit 94 } exit 0' "$TARGET_FILE"`,
    'VERIFY_STATUS=$?',
    '[ "$VERIFY_STATUS" -eq 93 ] && { echo "verification failed: replace-missing-new" >&2; exit 93; }',
    '[ "$VERIFY_STATUS" -eq 94 ] && { echo "verification failed: replace-old-still-present" >&2; exit 94; }',
    '[ "$VERIFY_STATUS" -eq 0 ] || exit "$VERIFY_STATUS"',
  ].join('\n')
}

function buildInsertRelativeToAnchorCommand(filePath, anchor, insertText, position) {
  const expectedFragment = position === 'before' ? `${insertText}${anchor}` : `${anchor}${insertText}`
  const replacementExpression = position === 'before' ? '$insert . $anchor' : '$anchor . $insert'
  return [
    `export TARGET_FILE=${bashSingleQuote(filePath)}`,
    `export ANCHOR=${bashSingleQuote(anchor)}`,
    `export INSERT_TEXT=${bashSingleQuote(insertText)}`,
    `export EXPECTED_FRAGMENT=${bashSingleQuote(expectedFragment)}`,
    `perl -0pi -e 'BEGIN { $anchor = $ENV{"ANCHOR"}; $insert = $ENV{"INSERT_TEXT"}; } s/\\Q$anchor\\E/${replacementExpression}/e or die "anchor not found\\n"' ${bashSingleQuote(filePath)}`,
    `perl -0e 'my $expected = $ENV{"EXPECTED_FRAGMENT"}; my $actual = do { local (@ARGV, $/) = shift; <> }; exit(index($actual, $expected) >= 0 ? 0 : 96)' "$TARGET_FILE" || { echo "verification failed: insert-${position}" >&2; exit 96; }`,
  ].join('\n')
}

function buildDeleteFileCommand(filePath) {
  return [
    `export TARGET_FILE=${bashSingleQuote(filePath)}`,
    `rm -f -- ${bashSingleQuote(filePath)}`,
    '[ ! -e "$TARGET_FILE" ] || { echo "verification failed: delete" >&2; exit 97; }',
  ].join('\n')
}

function buildRenameFileCommand(fromPath, toPath) {
  return [
    `export FROM_PATH=${bashSingleQuote(fromPath)}`,
    `export TO_PATH=${bashSingleQuote(toPath)}`,
    `mv -- ${bashSingleQuote(fromPath)} ${bashSingleQuote(toPath)}`,
    '[ ! -e "$FROM_PATH" ] || { echo "verification failed: rename-source-still-exists" >&2; exit 98; }',
    '[ -e "$TO_PATH" ] || { echo "verification failed: rename-destination-missing" >&2; exit 99; }',
  ].join('\n')
}

function buildCreateDirectoryCommand(dirPath) {
  return [
    `export TARGET_DIR=${bashSingleQuote(dirPath)}`,
    `mkdir -p -- ${bashSingleQuote(dirPath)}`,
    '[ -d "$TARGET_DIR" ] || { echo "verification failed: create-directory" >&2; exit 100; }',
  ].join('\n')
}

function buildSyntheticBashToolUse(command, reason) {
  return { id: `toolu_${randomUUID().replace(/-/g, '')}`, name: 'Bash', input: { command }, reason }
}

function shouldInspectAssistantTextForCommand(userText) {
  const intent = classifyFallbackIntent(userText)
  return intent === 'search_files' || intent === 'run_command' || intent === 'scaffold_files'
}

function commandMatchesIntent(command, userText) {
  const intent = classifyFallbackIntent(userText)
  const firstWord = command.split(/\s+/)[0]
  if (intent === 'run_command') return true
  if (intent === 'search_files') return ['find', 'grep', 'rg', 'ls', 'cat', 'head'].includes(firstWord)
  if (intent === 'scaffold_files') return SAFE_SCAFFOLD_COMMANDS.has(firstWord)
  return false
}

function maybeBuildSyntheticToolUse(body, originalToolNames, assistantText = '') {
  if (!originalToolNames.has('Bash')) return null
  if (latestUserTurnIsToolResultContinuation(body.messages)) return null
  const latestUserText = getLatestUserText(body.messages)
  const createDirectory = maybeParseCreateDirectoryIntent(latestUserText)
  if (createDirectory) return buildSyntheticBashToolUse(buildCreateDirectoryCommand(createDirectory.dirPath), 'synthetic_create_directory_via_bash')
  const createFile = maybeParseCreateFileIntent(latestUserText)
  if (createFile) return buildSyntheticBashToolUse(buildCreateFileCommand(createFile.fileName, createFile.content), 'synthetic_create_file_via_bash')
  const writeFile = maybeParseWriteFileIntent(latestUserText)
  if (writeFile) return buildSyntheticBashToolUse(buildWriteFileCommand(writeFile.filePath, writeFile.content), 'synthetic_write_file_via_bash')
  if (maybeParseListDirectoryIntent(latestUserText)) return buildSyntheticBashToolUse('ls -la', 'synthetic_list_directory_via_bash')
  const readFile = maybeParseReadFileIntent(latestUserText)
  if (readFile) return buildSyntheticBashToolUse(buildReadFileCommand(readFile.filePath), 'synthetic_read_file_via_bash')
  const appendFile = maybeParseAppendIntent(latestUserText)
  if (appendFile) return buildSyntheticBashToolUse(buildAppendFileCommand(appendFile.filePath, appendFile.content), 'synthetic_append_file_via_bash')
  const replaceInFile = maybeParseReplaceIntent(latestUserText)
  if (replaceInFile) return buildSyntheticBashToolUse(buildReplaceInFileCommand(replaceInFile.filePath, replaceInFile.oldString, replaceInFile.newString), 'synthetic_replace_in_file_via_bash')
  const insertAfter = maybeParseInsertAfterIntent(latestUserText)
  if (insertAfter) return buildSyntheticBashToolUse(buildInsertRelativeToAnchorCommand(insertAfter.filePath, insertAfter.anchor, insertAfter.insertText, 'after'), 'synthetic_insert_after_via_bash')
  const insertBefore = maybeParseInsertBeforeIntent(latestUserText)
  if (insertBefore) return buildSyntheticBashToolUse(buildInsertRelativeToAnchorCommand(insertBefore.filePath, insertBefore.anchor, insertBefore.insertText, 'before'), 'synthetic_insert_before_via_bash')
  const deleteFile = maybeParseDeleteFileIntent(latestUserText)
  if (deleteFile) return buildSyntheticBashToolUse(buildDeleteFileCommand(deleteFile.filePath), 'synthetic_delete_file_via_bash')
  const renameFile = maybeParseRenameFileIntent(latestUserText)
  if (renameFile) return buildSyntheticBashToolUse(buildRenameFileCommand(renameFile.fromPath, renameFile.toPath), 'synthetic_rename_file_via_bash')
  if (shouldInspectAssistantTextForCommand(latestUserText)) {
    if (classifyFallbackIntent(latestUserText) === 'scaffold_files') {
      const script = extractSafeScaffoldScript(assistantText)
      if (script) return buildSyntheticBashToolUse(script, 'synthetic_scaffold_script_via_bash')
    }
    const command = extractStandaloneCommand(assistantText)
    if (command && commandMatchesIntent(command, latestUserText)) return buildSyntheticBashToolUse(command, 'synthetic_model_command_via_bash')
  }
  return null
}

function resolveCorsOrigin(req) {
  if (config.allowCorsWildcard) return '*'
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || !origin) return ''
  try {
    const parsed = new URL(origin)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]') return origin
  } catch { return '' }
  return ''
}

function sendJson(res, statusCode, body, req = null) {
  const json = JSON.stringify(body)
  const headers = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) }
  const allowOrigin = resolveCorsOrigin(req)
  if (allowOrigin) { headers['access-control-allow-origin'] = allowOrigin; if (allowOrigin !== '*') headers.vary = 'Origin' }
  res.writeHead(statusCode, headers)
  res.end(json)
}

function sendAnthropicError(res, statusCode, message, type = 'api_error', req = null) {
  sendJson(res, statusCode, { type: 'error', error: { type, message } }, req)
}

function getAnthropicErrorTypeForStatus(statusCode, defaultType = 'api_error') {
  if (statusCode === 401) return 'authentication_error'
  if (statusCode === 429) return 'rate_limit_error'
  if (statusCode >= 400 && statusCode < 500) return 'invalid_request_error'
  return defaultType
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_REQUEST_BODY_BYTES) {
      const error = new Error(`Request body exceeds maximum of ${MAX_REQUEST_BODY_BYTES} bytes`)
      error.name = 'PayloadTooLargeError'
      throw error
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function extractApiKey(req) {
  const header = req.headers['x-api-key']
  if (typeof header === 'string' && header) return header
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  return ''
}

function constantTimeStringEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8')
  const bufB = Buffer.from(String(b), 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function authorize(req, res) {
  if (!config.shimApiKey) return true
  const incoming = extractApiKey(req)
  if (incoming && constantTimeStringEqual(incoming, config.shimApiKey)) return true
  sendAnthropicError(res, 401, 'invalid x-api-key', 'authentication_error', req)
  return false
}

function getResolvedModel(requestedModel) {
  if (config.useRequestedModel && requestedModel) return requestedModel
  return config.ollamaModel
}

function getOllamaHeaders() {
  const headers = { 'content-type': 'application/json' }
  if (config.ollamaAuthToken) headers.authorization = `Bearer ${config.ollamaAuthToken}`
  return headers
}

function stringifyContent(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item
      if (item?.type === 'text' && typeof item.text === 'string') return item.text
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    return JSON.stringify(value)
  }
  return String(value)
}

function systemToString(system) {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    }).filter(Boolean).join('\n\n')
  }
  return ''
}

const SHIM_TOOL_USE_SYSTEM_PREFIX = [
  'Tool-use mode:',
  '- When tools are available and the task requires an action on the filesystem, shell, web, or external resources, you MUST respond with native tool calls instead of describing the action in text.',
  '- Never claim that a file was created, edited, or deleted unless you actually called a tool and received a successful tool result.',
  '- Never print shell commands as a substitute for using a tool.',
  '- For file creation, prefer the Write tool.',
  '- For file modification, prefer the Edit tool after using the Read tool when needed.',
  '- For directory inspection or arbitrary commands, prefer the Bash tool.',
  '- If no tool is needed, answer normally in plain text.',
].join('\n')

function normalizeAnthropicMessages(messages, system) {
  const normalized = []
  const systemText = systemToString(system)
  const hasToolResult = (messages || []).some(message => Array.isArray(message?.content) && message.content.some(block => block?.type === 'tool_result'))
  const hasIncomingTools = Array.isArray(messages) ? messages.some(message => Array.isArray(message?.content) && message.content.some(block => block?.type === 'tool_use')) : false
  if (systemText) {
    normalized.push({ role: 'system', content: `${SHIM_TOOL_USE_SYSTEM_PREFIX}\n\n${systemText}` })
  } else if (hasIncomingTools || hasToolResult) {
    normalized.push({ role: 'system', content: SHIM_TOOL_USE_SYSTEM_PREFIX })
  }
  for (const message of messages || []) {
    if (!message || !message.role) continue
    if (typeof message.content === 'string') { normalized.push({ role: message.role, content: message.content }); continue }
    if (!Array.isArray(message.content)) { normalized.push({ role: message.role, content: stringifyContent(message.content) }); continue }
    if (message.role === 'assistant') {
      let text = ''
      const toolCalls = []
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') text += block.text
        else if (block.type === 'tool_use') toolCalls.push({ function: { name: block.name, arguments: block.input || {} } })
      }
      if (text || toolCalls.length > 0) normalized.push({ role: 'assistant', content: text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) })
      continue
    }
    if (message.role === 'user') {
      let pendingUserText = ''
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') { pendingUserText += block.text; continue }
        if (block.type === 'tool_result') {
          if (pendingUserText) { normalized.push({ role: 'user', content: pendingUserText }); pendingUserText = '' }
          normalized.push({ role: 'tool', content: stringifyContent(block.content) })
          continue
        }
        pendingUserText += stringifyContent(block)
      }
      if (pendingUserText) normalized.push({ role: 'user', content: pendingUserText })
      continue
    }
    normalized.push({ role: message.role, content: stringifyContent(message.content) })
  }
  return normalized
}

const TOOL_NAME_ALIASES = { Bash: 'run_command', Read: 'read_file', Write: 'write_file', Edit: 'edit_file', Glob: 'find_files', Grep: 'search_files', WebFetch: 'fetch_web', WebSearch: 'search_web', PowerShell: 'run_powershell' }
const TOOL_DESCRIPTION_OVERRIDES = { Bash: 'Run a shell command in the current workspace.', Read: 'Read a file from the filesystem.', Write: 'Create a new file or overwrite a file with exact contents.', Edit: 'Modify an existing file by applying a targeted edit.', Glob: 'Find files matching a pattern.', Grep: 'Search for text patterns across files.', WebFetch: 'Fetch and read a webpage.', WebSearch: 'Search the web for information.', PowerShell: 'Run a PowerShell command in the current workspace.' }

function getAliasedToolName(name) { return TOOL_NAME_ALIASES[name] || name }
function getToolDescription(name, fallbackDescription) {
  const base = TOOL_DESCRIPTION_OVERRIDES[name] || fallbackDescription || ''
  return base ? `${base} Original tool name: ${name}.` : `Original tool name: ${name}.`
}

function anthropicToolsToOllamaTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools: undefined, toolNameMap: {} }
  const toolNameMap = {}
  const converted = tools.map(tool => {
    const aliasedName = getAliasedToolName(tool.name)
    toolNameMap[aliasedName] = tool.name
    return { type: 'function', function: { name: aliasedName, description: getToolDescription(tool.name, tool.description), parameters: tool.input_schema || { type: 'object', properties: {} } } }
  })
  return { tools: converted, toolNameMap }
}

function capToolsRoundRobin(tools, maxTools) {
  if (!Array.isArray(tools) || tools.length <= maxTools) return tools
  const byServer = new Map()
  for (const tool of tools) {
    const name = tool?.function?.name || 'default'
    const server = name.includes('__') ? name.split('__')[0] : 'default'
    if (!byServer.has(server)) byServer.set(server, [])
    byServer.get(server).push(tool)
  }
  const buckets = [...byServer.values()]
  const result = []
  let index = 0
  while (result.length < maxTools) {
    let added = false
    for (const bucket of buckets) {
      if (index < bucket.length) { result.push(bucket[index]); added = true; if (result.length >= maxTools) break }
    }
    if (!added) break
    index += 1
  }
  return result
}

const CORE_TOOL_PRIORITY = ['Bash','Read','Write','Edit','Glob','Grep','PowerShell','WebFetch','WebSearch','Task','TaskOutput','TodoWrite']
const DEPRIORITIZED_TOOL_PREFIXES = ['Cron']
const DEPRIORITIZED_TOOL_NAMES = new Set(['Agent','AskUserQuestion','EnterPlanMode','ExitPlanMode','Config'])

function toolPriorityScore(tool) {
  const name = tool?.function?.name || ''
  const exactIndex = CORE_TOOL_PRIORITY.indexOf(name)
  if (exactIndex !== -1) return exactIndex - 1000
  if (DEPRIORITIZED_TOOL_NAMES.has(name)) return 10_000
  if (DEPRIORITIZED_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))) return 9_000
  return 1_000
}

function prioritizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools
  return [...tools].sort((a, b) => {
    const scoreDiff = toolPriorityScore(a) - toolPriorityScore(b)
    if (scoreDiff !== 0) return scoreDiff
    return (a?.function?.name || '').localeCompare(b?.function?.name || '')
  })
}

function estimateTokensFromText(text) {
  if (!text) return 0
  return Math.max(1, Math.ceil(String(text).length / 4))
}

function estimateInputTokens(body) {
  const systemText = systemToString(body.system)
  let total = estimateTokensFromText(systemText)
  for (const message of body.messages || []) {
    if (typeof message.content === 'string') { total += estimateTokensFromText(message.content) }
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text') total += estimateTokensFromText(block.text)
        else if (block?.type === 'tool_use') { total += estimateTokensFromText(block.name); total += estimateTokensFromText(JSON.stringify(block.input || {})) }
        else if (block?.type === 'tool_result') total += estimateTokensFromText(stringifyContent(block.content))
      }
    }
  }
  if (Array.isArray(body.tools)) total += estimateTokensFromText(JSON.stringify(body.tools))
  return total
}

function buildOllamaPayload(body, stream) {
  const { tools: convertedTools, toolNameMap } = anthropicToolsToOllamaTools(body.tools)
  const prioritizedTools = prioritizeTools(convertedTools)
  const cappedTools = prioritizedTools && Number.isFinite(config.maxTools) && config.maxTools > 0 ? capToolsRoundRobin(prioritizedTools, config.maxTools) : prioritizedTools
  const payload = { model: getResolvedModel(body.model), messages: normalizeAnthropicMessages(body.messages || [], body.system), stream, think: false, keep_alive: -1 }
  if (cappedTools?.length) payload.tools = cappedTools
  const options = {}
  if (typeof body.max_tokens === 'number' && body.max_tokens > 0) options.num_predict = body.max_tokens
  if (typeof body.temperature === 'number') options.temperature = body.temperature
  if (config.ollamaNumCtx) options.num_ctx = config.ollamaNumCtx
  if (Object.keys(options).length > 0) payload.options = options
  const activeToolNameMap = {}
  const activeOriginalToolNames = new Set()
  for (const tool of cappedTools || []) {
    const aliasedName = tool?.function?.name
    if (aliasedName && toolNameMap[aliasedName]) { activeToolNameMap[aliasedName] = toolNameMap[aliasedName]; activeOriginalToolNames.add(toolNameMap[aliasedName]) }
  }
  return { payload, toolNameMap: activeToolNameMap, activeOriginalToolNames }
}

function generateAnthropicMessageSkeleton(model, inputTokens) {
  return { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } }
}

function mapDoneReasonToStopReason(doneReason, sawToolUse) {
  if (sawToolUse) return 'tool_use'
  if (doneReason === 'length') return 'max_tokens'
  return 'end_turn'
}

function isToolUnsupportedUpstreamError(status, text) {
  if (status < 400) return false
  const normalized = String(text || '').toLowerCase()
  return normalized.includes('does not support tools') || normalized.includes('does not support functions') || normalized.includes('tool calling is not supported')
}

function isUpstreamTimeoutError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timed out/i.test(String(error?.message || ''))
}

function createInvalidUpstreamError(message) {
  const error = new Error(message)
  error.name = 'InvalidUpstreamResponseError'
  return error
}

function createClientDisconnectController(req, res) {
  const controller = new AbortController()
  let disconnected = false
  const abort = () => { if (disconnected) return; disconnected = true; controller.abort(new Error('Client disconnected')) }
  req.on('aborted', abort); req.on('close', abort); res.on('close', abort)
  return { signal: controller.signal, wasDisconnected: () => disconnected, cleanup: () => { req.off('aborted', abort); req.off('close', abort); res.off('close', abort) } }
}

function createCombinedAbortSignal(signals = []) {
  const activeSignals = signals.filter(Boolean)
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]
  const controller = new AbortController()
  const cleanupFns = []
  const abortFrom = signal => {
    if (controller.signal.aborted) return
    controller.abort(signal?.reason instanceof Error ? signal.reason : new Error(signal?.reason || 'Aborted'))
    for (const cleanup of cleanupFns) cleanup()
  }
  for (const signal of activeSignals) {
    if (signal.aborted) { abortFrom(signal); return controller.signal }
    const handler = () => abortFrom(signal)
    signal.addEventListener('abort', handler, { once: true })
    cleanupFns.push(() => signal.removeEventListener('abort', handler))
  }
  return controller.signal
}

async function postToOllamaWithToolFallback(payload, options = {}) {
  const combinedSignal = createCombinedAbortSignal([
    Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0 ? AbortSignal.timeout(config.requestTimeoutMs) : undefined,
    options.signal,
  ])
  const tryPost = async candidatePayload => {
    try {
      return await fetch(`${config.ollamaBaseUrl}/api/chat`, { method: 'POST', headers: getOllamaHeaders(), body: JSON.stringify(candidatePayload), signal: combinedSignal })
    } catch (error) {
      if (options.signal?.aborted) { const e = new Error('Client disconnected before upstream response completed'); e.name = 'ClientDisconnectedError'; throw e }
      if (isUpstreamTimeoutError(error)) { const e = new Error(`Upstream Ollama request timed out after ${config.requestTimeoutMs}ms`); e.name = 'UpstreamTimeoutError'; throw e }
      throw error
    }
  }
  let response = await tryPost(payload)
  if (!response.ok) {
    const errorText = await response.text().catch(() => `HTTP ${response.status}`)
    if (payload.tools && isToolUnsupportedUpstreamError(response.status, errorText)) {
      logDebug('upstream model rejected tools, retrying without tools')
      const fallbackPayload = { ...payload }
      delete fallbackPayload.tools
      response = await tryPost(fallbackPayload)
      return { response, toolFallbackUsed: true, initialErrorText: errorText }
    }
    return { response, toolFallbackUsed: false, initialErrorText: errorText }
  }
  return { response, toolFallbackUsed: false, initialErrorText: '' }
}

function coerceToolArguments(rawArguments) {
  if (rawArguments == null) return {}
  if (typeof rawArguments === 'string') {
    const trimmed = rawArguments.trim()
    if (!trimmed) return {}
    try { const parsed = JSON.parse(trimmed); return parsed && typeof parsed === 'object' ? parsed : { value: parsed } } catch { return { value: rawArguments } }
  }
  if (typeof rawArguments === 'object') return rawArguments
  return { value: rawArguments }
}

function normalizeToolCalls(toolCalls, toolNameMap = {}) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map(call => {
    const fn = call?.function || {}
    return { id: `toolu_${randomUUID().replace(/-/g, '')}`, name: toolNameMap[fn.name] || fn.name || 'unknown_tool', input: coerceToolArguments(fn.arguments) }
  }).filter(call => call.name)
}

async function handleStreaming(body, req, res) {
  const { payload: ollamaPayload, toolNameMap, activeOriginalToolNames } = buildOllamaPayload(body, true)
  const inputTokens = estimateInputTokens(body)
  const model = ollamaPayload.model
  const latestUserText = getLatestUserText(body.messages)
  const initialSyntheticToolUse = maybeBuildSyntheticToolUse(body, activeOriginalToolNames)
  const shouldInspectForSyntheticFallback = activeOriginalToolNames.has('Bash') && !latestUserTurnIsToolResultContinuation(body.messages) && (Boolean(initialSyntheticToolUse) || shouldInspectAssistantTextForCommand(latestUserText))
  const disconnect = createClientDisconnectController(req, res)
  const { response: upstream, toolFallbackUsed, initialErrorText } = await postToOllamaWithToolFallback(ollamaPayload, { signal: disconnect.signal })
  if (!upstream.ok || !upstream.body) {
    const text = initialErrorText || (await upstream.text().catch(() => `HTTP ${upstream.status}`))
    sendAnthropicError(res, upstream.ok ? 502 : upstream.status, `Upstream Ollama error: ${text}`, getAnthropicErrorTypeForStatus(upstream.ok ? 502 : upstream.status), req)
    return
  }
  const streamingHeaders = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  const streamingAllowOrigin = resolveCorsOrigin(req)
  if (streamingAllowOrigin) { streamingHeaders['access-control-allow-origin'] = streamingAllowOrigin; if (streamingAllowOrigin !== '*') streamingHeaders.vary = 'Origin' }
  res.writeHead(200, streamingHeaders)
  const message = generateAnthropicMessageSkeleton(model, inputTokens)
  writeSseEvent(res, 'message_start', { type: 'message_start', message })
  const decoder = new TextDecoder()
  const reader = upstream.body.getReader()
  let buffer = '', contentIndex = 0, textBlockOpen = false, sawToolUse = false, outputTokens = 0, bufferedText = '', sawValidChunk = false
  const holdTextForSyntheticFallback = shouldInspectForSyntheticFallback
  let streamCompleted = false
  const openTextBlock = () => {
    if (textBlockOpen) return
    writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } })
    textBlockOpen = true
  }
  const closeTextBlock = () => {
    if (!textBlockOpen) return
    writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })
    textBlockOpen = false; contentIndex += 1
  }
  try {
    if (toolFallbackUsed) {
      writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'text', text: '' } })
      textBlockOpen = true
      writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: '[Shim note: upstream model does not support tool calling; continuing without tools.]\n\n' } })
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_UPSTREAM_STREAM_LINE_BYTES) throw createInvalidUpstreamError(`Upstream Ollama streaming line exceeded ${MAX_UPSTREAM_STREAM_LINE_BYTES} bytes without a newline`)
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        let chunk
        try { chunk = JSON.parse(line) } catch { continue }
        sawValidChunk = true
        const messageChunk = chunk.message || {}
        if (typeof messageChunk.content === 'string' && messageChunk.content) {
          if (holdTextForSyntheticFallback) { bufferedText += messageChunk.content }
          else { openTextBlock(); writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: messageChunk.content } }) }
        }
        const toolUses = normalizeToolCalls(messageChunk.tool_calls, toolNameMap)
        if (toolUses.length > 0) {
          sawToolUse = true; closeTextBlock()
          for (const toolUse of toolUses) {
            writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} } })
            writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input || {}) } })
            writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })
            contentIndex += 1
          }
        }
        if (chunk.done) {
          outputTokens = chunk.eval_count || outputTokens || 0
          const resolvedSyntheticToolUse = !sawToolUse && holdTextForSyntheticFallback ? maybeBuildSyntheticToolUse(body, activeOriginalToolNames, bufferedText) : null
          if (resolvedSyntheticToolUse) {
            writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'tool_use', id: resolvedSyntheticToolUse.id, name: resolvedSyntheticToolUse.name, input: {} } })
            writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(resolvedSyntheticToolUse.input) } })
            writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })
            contentIndex += 1; sawToolUse = true
          } else if (bufferedText) {
            openTextBlock()
            writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: bufferedText } })
            bufferedText = ''
          }
          closeTextBlock()
          writeSseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: mapDoneReasonToStopReason(chunk.done_reason, sawToolUse), stop_sequence: null }, usage: { output_tokens: outputTokens } })
          writeSseEvent(res, 'message_stop', { type: 'message_stop' })
          streamCompleted = true; res.end(); return
        }
      }
    }
    const resolvedSyntheticToolUse = !sawToolUse && holdTextForSyntheticFallback ? maybeBuildSyntheticToolUse(body, activeOriginalToolNames, bufferedText) : null
    if (!sawValidChunk && !resolvedSyntheticToolUse && !bufferedText) throw createInvalidUpstreamError('Upstream Ollama returned an invalid streaming response')
    if (resolvedSyntheticToolUse) {
      writeSseEvent(res, 'content_block_start', { type: 'content_block_start', index: contentIndex, content_block: { type: 'tool_use', id: resolvedSyntheticToolUse.id, name: resolvedSyntheticToolUse.name, input: {} } })
      writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(resolvedSyntheticToolUse.input) } })
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: contentIndex })
      contentIndex += 1; sawToolUse = true
    } else if (bufferedText) {
      openTextBlock()
      writeSseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: contentIndex, delta: { type: 'text_delta', text: bufferedText } })
      bufferedText = ''
    }
    closeTextBlock()
    writeSseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: sawToolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })
    writeSseEvent(res, 'message_stop', { type: 'message_stop' })
    streamCompleted = true; res.end()
  } catch (error) {
    if (error?.name === 'ClientDisconnectedError' || disconnect.wasDisconnected()) { logDebug('streaming client disconnected'); return }
    logDebug('streaming error', error)
    if (!res.writableEnded) { writeSseEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : 'Unknown streaming error' } }); res.end() }
  } finally {
    disconnect.cleanup()
    if (!streamCompleted) await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch {}
  }
}

async function handleNonStreaming(body, req, res) {
  const { payload: ollamaPayload, toolNameMap, activeOriginalToolNames } = buildOllamaPayload(body, false)
  const estimatedInputTokens = estimateInputTokens(body)
  const latestUserText = getLatestUserText(body.messages)
  const syntheticToolUse = maybeBuildSyntheticToolUse(body, activeOriginalToolNames)
  const disconnect = createClientDisconnectController(req, res)
  const { response: upstream, toolFallbackUsed, initialErrorText } = await postToOllamaWithToolFallback(ollamaPayload, { signal: disconnect.signal })
  if (!upstream.ok) {
    const text = initialErrorText || (await upstream.text().catch(() => `HTTP ${upstream.status}`))
    sendAnthropicError(res, upstream.status, `Upstream Ollama error: ${text}`, getAnthropicErrorTypeForStatus(upstream.status), req)
    return
  }
  try {
    let chunk
    try { chunk = await upstream.json() } catch { throw createInvalidUpstreamError('Upstream Ollama returned invalid JSON') }
    const messageChunk = chunk.message || {}
    const toolUses = normalizeToolCalls(messageChunk.tool_calls, toolNameMap)
    const resolvedSyntheticToolUse = toolUses.length === 0 ? maybeBuildSyntheticToolUse(body, activeOriginalToolNames, typeof messageChunk.content === 'string' ? messageChunk.content : '') : null
    const content = []
    if (toolFallbackUsed) content.push({ type: 'text', text: '[Shim note: upstream model does not support tool calling; continuing without tools.]\n\n' })
    if (typeof messageChunk.content === 'string' && messageChunk.content && !resolvedSyntheticToolUse) content.push({ type: 'text', text: messageChunk.content })
    const finalToolUses = toolUses.length > 0 ? toolUses : resolvedSyntheticToolUse ? [{ id: resolvedSyntheticToolUse.id, name: resolvedSyntheticToolUse.name, input: resolvedSyntheticToolUse.input }] : []
    for (const toolUse of finalToolUses) content.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input })
    sendJson(res, 200, { id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model: ollamaPayload.model, content, stop_reason: mapDoneReasonToStopReason(chunk.done_reason, finalToolUses.length > 0), stop_sequence: null, usage: { input_tokens: chunk.prompt_eval_count || estimatedInputTokens, output_tokens: chunk.eval_count || estimateTokensFromText(messageChunk.content || '') } }, req)
  } finally {
    disconnect.cleanup()
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'OPTIONS') {
    const optionsHeaders = { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-api-key,authorization,anthropic-version,anthropic-beta' }
    const allowOrigin = resolveCorsOrigin(req)
    if (allowOrigin) { optionsHeaders['access-control-allow-origin'] = allowOrigin; if (allowOrigin !== '*') optionsHeaders.vary = 'Origin' }
    res.writeHead(204, optionsHeaders); res.end(); return
  }
  if (url.pathname === '/health') { sendJson(res, 200, { ok: true, upstream: sanitizeUpstreamUrl(config.ollamaBaseUrl), model: config.ollamaModel }, req); return }
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    sendJson(res, 200, { data: [{ id: config.ollamaModel, type: 'model', display_name: config.ollamaModel, created_at: new Date().toISOString() }], has_more: false, first_id: config.ollamaModel, last_id: config.ollamaModel }, req)
    return
  }
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    if (!authorize(req, res)) return
    let body
    try { body = await readJsonBody(req) } catch (error) {
      if (error?.name === 'PayloadTooLargeError') { sendAnthropicError(res, 413, error.message, 'invalid_request_error', req); return }
      sendAnthropicError(res, 400, error instanceof Error ? error.message : 'Invalid JSON body', 'invalid_request_error', req); return
    }
    if (!Array.isArray(body.messages)) { sendAnthropicError(res, 400, 'messages must be an array', 'invalid_request_error', req); return }
    try {
      if (body.stream) await handleStreaming(body, req, res)
      else await handleNonStreaming(body, req, res)
    } catch (error) {
      if (error?.name === 'ClientDisconnectedError') return
      if (error?.name === 'UpstreamTimeoutError') { sendAnthropicError(res, 504, error.message, 'timeout_error', req); return }
      if (error?.name === 'InvalidUpstreamResponseError') { sendAnthropicError(res, 502, error.message, 'invalid_response_error', req); return }
      sendAnthropicError(res, 500, error instanceof Error ? error.message : 'Internal server error', 'api_error', req)
    }
    return
  }
  sendJson(res, 404, { error: 'Not found' }, req)
}

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    if (res.writableEnded || res.headersSent) return
    if (error?.name === 'UpstreamTimeoutError') { sendAnthropicError(res, 504, error.message, 'timeout_error', req); return }
    if (error?.name === 'InvalidUpstreamResponseError') { sendAnthropicError(res, 502, error.message, 'invalid_response_error', req); return }
    sendAnthropicError(res, 500, error instanceof Error ? error.message : 'Unhandled server error', 'api_error', req)
  })
})

server.listen(config.port, config.host, () => {
  console.error(`[shim] listening on http://${config.host}:${config.port} -> ${config.ollamaBaseUrl} (${config.ollamaModel})`)
})
