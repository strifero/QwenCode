import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const shimBaseUrl = process.env.SHIM_BASE_URL || 'http://127.0.0.1:8000'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function toBashPath(windowsPath) {
  const resolved = path.resolve(windowsPath)
  const slashified = resolved.replace(/\\/g, '/')
  const driveMatch = slashified.match(/^([A-Za-z]):\/(.*)$/)
  if (!driveMatch) return slashified
  return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`
}

async function postMessages(body) {
  const response = await fetch(`${shimBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`)
  return json
}

async function postStreamingMessages(body) {
  const response = await fetch(`${shimBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}: ${text}`)
  }
  const raw = await response.text()
  const events = []
  let currentEvent = 'message'
  const dataLines = []
  const flush = () => {
    if (dataLines.length === 0) return
    events.push({ event: currentEvent, data: JSON.parse(dataLines.join('\n')) })
    dataLines.length = 0
    currentEvent = 'message'
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) { flush(); continue }
    if (line.startsWith('event: ')) { currentEvent = line.slice('event: '.length); continue }
    if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
  }
  flush()
  return events
}

async function callShim(prompt, tools = ['Bash']) {
  const toolDefs = tools.map(name => ({
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }))
  return postMessages({
    model: 'ignored',
    stream: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: toolDefs,
  })
}

function expectToolUse(response) {
  const toolUse = response.content?.find(block => block?.type === 'tool_use')
  if (!toolUse) throw new Error(`Expected tool_use, got: ${JSON.stringify(response.content)}`)
  return toolUse
}

async function runBashInDir(dir, command) {
  const { spawn } = await import('node:child_process')
  const scriptPath = path.join(dir, '__shim_smoke__.sh')
  await writeFile(scriptPath, `cd ${bashSingleQuote(toBashPath(dir))}\n${command}`, 'utf8')
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', [toBashPath(scriptPath)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`bash exit ${code}: ${stderr || stdout}`)))
    child.on('error', reject)
  })
}

async function prepareTestDir(name) {
  const dir = path.join(repoRoot, '.tmp-smoke', name)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

async function testTargetedFileOps() {
  const dir = await prepareTestDir('targeted')
  try {
    const create = expectToolUse(await callShim('create a file called sample.txt with the text alpha'))
    await runBashInDir(dir, create.input.command)
    let content = await readFile(path.join(dir, 'sample.txt'), 'utf8')
    if (content !== 'alpha') throw new Error(`create mismatch: ${JSON.stringify(content)}`)

    const append = expectToolUse(await callShim('append the text "beta" to sample.txt'))
    await runBashInDir(dir, append.input.command)
    content = await readFile(path.join(dir, 'sample.txt'), 'utf8')
    if (content !== 'alphabeta') throw new Error(`append mismatch: ${JSON.stringify(content)}`)

    const replace = expectToolUse(await callShim('replace the exact string "alpha" with "gamma" in sample.txt'))
    await runBashInDir(dir, replace.input.command)
    content = await readFile(path.join(dir, 'sample.txt'), 'utf8')
    if (content !== 'gammabeta') throw new Error(`replace mismatch: ${JSON.stringify(content)}`)

    return { input: 'create/append/replace sample.txt', expected: 'final content gammabeta', actual: `final content ${content}`, pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testMultilineAndWhitespace() {
  const dir = await prepareTestDir('multiline')
  try {
    const create = expectToolUse(await callShim('create a file called multi.txt with the text "alpha\nbeta"'))
    await runBashInDir(dir, create.input.command)
    const insert = expectToolUse(await callShim('insert the text "  AFTER  " after the exact string "alpha" in multi.txt'))
    await runBashInDir(dir, insert.input.command)
    const content = await readFile(path.join(dir, 'multi.txt'), 'utf8')
    if (content !== 'alpha  AFTER  \nbeta') throw new Error(`multiline mismatch: ${JSON.stringify(content)}`)
    return { input: 'multiline create + spaced insert', expected: 'alpha  AFTER  \\nbeta', actual: content.replace(/\n/g, '\\n'), pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testEmptyReplace() {
  const dir = await prepareTestDir('empty-replace')
  try {
    await writeFile(path.join(dir, 'empty.txt'), 'alphabeta', 'utf8')
    const replace = expectToolUse(await callShim('replace the exact string "alpha" with "" in empty.txt'))
    await runBashInDir(dir, replace.input.command)
    const content = await readFile(path.join(dir, 'empty.txt'), 'utf8')
    if (content !== 'beta') throw new Error(`empty replace mismatch: ${JSON.stringify(content)}`)
    return { input: 'replace alpha with empty string', expected: 'beta', actual: content, pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testBinaryReadFallsBack() {
  const dir = await prepareTestDir('binary-read')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 159, 255, 0, 1, 2]))
    const response = await callShim('read blob.bin')
    const toolUse = expectToolUse(response)
    const execution = await runBashInDir(dir, toolUse.input.command)
    const output = execution.stdout.trim()
    if (!output.includes('[shim] Binary file detected: blob.bin')) throw new Error(`binary read output mismatch: ${JSON.stringify(output)}`)
    return { input: 'read blob.bin', expected: 'prints a binary-file notice', actual: output, pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testLargeReadTruncates() {
  const dir = await prepareTestDir('large-read')
  try {
    const largeContent = 'A'.repeat(220000)
    await writeFile(path.join(dir, 'large.txt'), largeContent, 'utf8')
    const response = await callShim('read large.txt')
    const toolUse = expectToolUse(response)
    const execution = await runBashInDir(dir, toolUse.input.command)
    const output = execution.stdout
    if (!output.startsWith('[shim] File truncated to 200000 bytes: large.txt\n')) throw new Error(`large read notice mismatch: ${JSON.stringify(output.slice(0, 80))}`)
    const payload = output.slice('[shim] File truncated to 200000 bytes: large.txt\n'.length)
    if (payload.length !== 200000) throw new Error(`large read payload length mismatch: ${payload.length}`)
    return { input: 'read large.txt', expected: 'truncation notice + 200000 bytes', actual: `notice ok, payload=${payload.length}`, pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testRenameFile() {
  const dir = await prepareTestDir('rename-file')
  try {
    await writeFile(path.join(dir, 'old-name.txt'), 'rename me', 'utf8')
    const response = await callShim('rename old-name.txt to new-name.txt')
    const toolUse = expectToolUse(response)
    await runBashInDir(dir, toolUse.input.command)
    const oldExists = await readFile(path.join(dir, 'new-name.txt'), 'utf8')
    return { input: 'rename old-name.txt to new-name.txt', expected: 'new-name.txt exists with original content', actual: oldExists, pass: true }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testCreateDirectory() {
  const dir = await prepareTestDir('create-directory')
  try {
    const response = await callShim('create a directory called src/utils/helpers')
    const toolUse = expectToolUse(response)
    await runBashInDir(dir, toolUse.input.command)
    const targetPath = path.join(dir, 'src', 'utils', 'helpers')
    const { stat } = await import('node:fs/promises')
    const stats = await stat(targetPath)
    return { input: 'create a directory called src/utils/helpers', expected: 'directory exists', actual: String(stats.isDirectory()), pass: stats.isDirectory() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testNestedFileCreate() {
  const dir = await prepareTestDir('nested-create')
  try {
    const response = await callShim('create a file called src/components/Button.tsx with the text export const Button = () => null;')
    const toolUse = expectToolUse(response)
    await runBashInDir(dir, toolUse.input.command)
    const targetPath = path.join(dir, 'src', 'components', 'Button.tsx')
    const content = await readFile(targetPath, 'utf8')
    return { input: 'create nested file src/components/Button.tsx', expected: 'file exists with requested content', actual: content, pass: content === 'export const Button = () => null;' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testUnicodeContent() {
  const dir = await prepareTestDir('unicode')
  try {
    const create = expectToolUse(await callShim('create a file called unicode.txt with the text "Hello, café ☕ — 你好"'))
    await runBashInDir(dir, create.input.command)
    const replace = expectToolUse(await callShim('replace the exact string "你好" with "こんにちは" in unicode.txt'))
    await runBashInDir(dir, replace.input.command)
    const read = expectToolUse(await callShim('read unicode.txt'))
    const execution = await runBashInDir(dir, read.input.command)
    const content = execution.stdout
    const expected = 'Hello, café ☕ — こんにちは'
    return { input: 'unicode create/replace/read', expected, actual: content, pass: content === expected }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testStreamingTextResponse() {
  const events = await postStreamingMessages({
    model: 'ignored',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello in one sentence' }] }],
    tools: [],
  })
  const names = events.map(event => event.event)
  const hasStart = names.includes('message_start')
  const hasDelta = events.some(event => event.event === 'content_block_delta' && event.data?.delta?.type === 'text_delta')
  const stop = events.find(event => event.event === 'message_stop')
  if (!hasStart || !hasDelta || !stop) throw new Error(`streaming text event mismatch: ${JSON.stringify(names)}`)
  return { input: 'streaming text prompt', expected: 'message_start + text delta + message_stop', actual: names.join(', '), pass: true }
}

async function testStreamingToolUseResponse() {
  const events = await postStreamingMessages({
    model: 'ignored',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'create a file called stream-tool.txt with the text alpha' }] }],
    tools: [{ name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
  })
  const toolBlockStart = events.find(event => event.event === 'content_block_start' && event.data?.content_block?.type === 'tool_use')
  const inputDelta = events.find(event => event.event === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta')
  const messageDelta = events.find(event => event.event === 'message_delta' && event.data?.delta?.stop_reason === 'tool_use')
  if (!toolBlockStart || !inputDelta || !messageDelta) throw new Error(`streaming tool event mismatch: ${JSON.stringify(events.map(event => event.event))}`)
  return { input: 'streaming create-file prompt', expected: 'tool_use block with input_json_delta', actual: `${toolBlockStart.data.content_block.name} + ${messageDelta.data.delta.stop_reason}`, pass: true }
}

async function testContinuationTurnStillFallsBack() {
  const response = await postMessages({
    model: 'ignored',
    stream: false,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_prior', name: 'Bash', input: { command: 'ls -la' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_prior', content: 'prior listing complete' },
        { type: 'text', text: '<system-reminder>ignore this internal note</system-reminder>\ncreate a file called continuation.txt with the text after tool result' },
      ]},
    ],
    tools: [{ name: 'Bash', description: 'Run a shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
  })
  const toolUse = expectToolUse(response)
  if (!toolUse.input.command.includes("continuation.txt")) throw new Error(`continuation command mismatch: ${toolUse.input.command}`)
  return { input: 'tool_result continuation with real user text', expected: 'synthetic tool_use for continuation.txt', actual: toolUse.input.command, pass: true }
}

async function main() {
  const tests = [
    testTargetedFileOps,
    testMultilineAndWhitespace,
    testEmptyReplace,
    testBinaryReadFallsBack,
    testLargeReadTruncates,
    testCreateDirectory,
    testNestedFileCreate,
    testUnicodeContent,
    testRenameFile,
    testStreamingTextResponse,
    testStreamingToolUseResponse,
    testContinuationTurnStillFallsBack,
  ]
  const results = []
  for (const test of tests) {
    try {
      results.push(await test())
    } catch (error) {
      results.push({ input: test.name, expected: 'pass', actual: error instanceof Error ? error.message : String(error), pass: false })
    }
  }
  const failed = results.filter(result => !result.pass)
  console.log(JSON.stringify({ shimBaseUrl, results, failedCount: failed.length }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

await main()
