import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const mockScript = path.join(repoRoot, 'scripts', 'mock-ollama.mjs')
const shimScript = path.join(repoRoot, 'src', 'server.mjs')

function spawnNode(scriptPath, env = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  return { child, getStderr: () => stderr }
}

function stopChildTree(child) {
  if (!child?.pid) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}

async function waitFor(url, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function withServers({ mockMode, mockPort, shimPort, shimEnv = {} }, fn) {
  const mock = spawnNode(mockScript, { MOCK_OLLAMA_PORT: String(mockPort), MOCK_OLLAMA_MODE: mockMode, MOCK_OLLAMA_DELAY_MS: '3000' })
  try {
    await waitFor(`http://127.0.0.1:${mockPort}/health`)
    const shim = spawnNode(shimScript, { ...shimEnv, OLLAMA_BASE_URL: `http://127.0.0.1:${mockPort}`, OLLAMA_MODEL: 'mock-model', PORT: String(shimPort), HOST: '127.0.0.1' })
    try {
      await waitFor(`http://127.0.0.1:${shimPort}/health`)
      return await fn()
    } finally {
      stopChildTree(shim.child)
    }
  } finally {
    stopChildTree(mock.child)
  }
}

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

async function runBashInDir(dir, command) {
  const scriptPath = path.join(dir, '__shim_error_smoke__.sh')
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

async function testTimeoutHandling() {
  return withServers({ mockMode: 'delay', mockPort: 8221, shimPort: 8222, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '1000' } }, async () => {
    const res = await fetch('http://127.0.0.1:8222/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ignored', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }] }),
    })
    const body = await res.json()
    const pass = res.status === 504 && body?.error?.type === 'timeout_error' && /timed out/i.test(body?.error?.message || '')
    return { input: 'slow upstream non-streaming request', expected: '504 timeout_error', actual: `${res.status} ${body?.error?.type}: ${body?.error?.message}`, pass }
  })
}

async function testMalformedJsonHandling() {
  return withServers({ mockMode: 'malformed-json', mockPort: 8231, shimPort: 8232, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '1000' } }, async () => {
    const res = await fetch('http://127.0.0.1:8232/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ignored', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }] }),
    })
    const body = await res.json()
    const pass = res.status === 502 && body?.error?.type === 'invalid_response_error' && /invalid json/i.test(body?.error?.message || '')
    return { input: 'malformed JSON upstream response', expected: '502 invalid_response_error', actual: `${res.status} ${body?.error?.type}: ${body?.error?.message}`, pass }
  })
}

async function testRateLimitHandling() {
  return withServers({ mockMode: 'rate-limit', mockPort: 8281, shimPort: 8282, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '1000' } }, async () => {
    const res = await fetch('http://127.0.0.1:8282/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ignored', stream: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }] }),
    })
    const body = await res.json()
    const pass = res.status === 429 && body?.error?.type === 'rate_limit_error' && /rate limit/i.test(body?.error?.message || '')
    return { input: 'upstream 429 rate limit response', expected: '429 rate_limit_error', actual: `${res.status} ${body?.error?.type}: ${body?.error?.message}`, pass }
  })
}

async function testStreamingGarbageHandling() {
  return withServers({ mockMode: 'stream-garbage', mockPort: 8241, shimPort: 8242, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '1000' } }, async () => {
    const res = await fetch('http://127.0.0.1:8242/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ignored', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'say hello' }] }] }),
    })
    const raw = await res.text()
    const pass = res.status === 200 && raw.includes('event: error') && raw.includes('invalid streaming response')
    return { input: 'garbage streaming upstream response', expected: 'SSE error event for invalid streaming response', actual: raw.replace(/\r?\n/g, ' | '), pass }
  })
}

async function testInterruptedStreamingCancelsUpstream() {
  return withServers({ mockMode: 'stream-slow', mockPort: 8251, shimPort: 8252, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '10000' } }, async () => {
    const controller = new AbortController()
    const res = await fetch('http://127.0.0.1:8252/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model: 'ignored', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'stream forever' }] }] }),
    })
    const reader = res.body.getReader()
    const firstChunk = await reader.read()
    controller.abort()
    await reader.cancel().catch(() => {})
    await delay(500)
    const statsRes = await fetch('http://127.0.0.1:8251/stats')
    const stats = await statsRes.json()
    const shimHealthRes = await fetch('http://127.0.0.1:8252/health')
    const shimHealth = await shimHealthRes.json()
    const firstChunkText = Buffer.from(firstChunk.value || []).toString('utf8')
    const pass = firstChunk.done === false && firstChunkText.includes('message_start') && stats.abortedRequests >= 1 && shimHealth.ok === true
    return { input: 'interrupt streaming client request after first SSE chunk', expected: 'mock upstream sees an aborted request and shim stays healthy', actual: `abortedRequests=${stats.abortedRequests}; shimOk=${shimHealth.ok}; firstChunkHasMessageStart=${firstChunkText.includes('message_start')}`, pass }
  })
}

async function testScriptScaffoldFallback() {
  const dir = await prepareTestDir('mock-scaffold')
  try {
    return await withServers({ mockMode: 'script-json', mockPort: 8261, shimPort: 8262, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '10000' } }, async () => {
      const res = await fetch('http://127.0.0.1:8262/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ignored', stream: false,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'create a Python script and a README for a demo app' }] }],
          tools: [{ name: 'Bash', description: 'Run shell commands', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
        }),
      })
      const body = await res.json()
      const toolUse = body?.content?.find(block => block?.type === 'tool_use')
      if (!toolUse?.input?.command) throw new Error(`Expected tool_use, got ${JSON.stringify(body)}`)
      await runBashInDir(dir, toolUse.input.command)
      const app = await readFile(path.join(dir, 'src', 'app.py'), 'utf8')
      const readme = await readFile(path.join(dir, 'README.md'), 'utf8')
      const pass = app === 'print("hello")\n' && readme === '# Demo\n'
      return { input: 'assistant emits fenced multi-file scaffold script', expected: 'synthetic Bash tool_use creates src/app.py and README.md', actual: `app=${JSON.stringify(app)} readme=${JSON.stringify(readme)}`, pass }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testLargeContextContinuationFallback() {
  const dir = await prepareTestDir('large-context')
  try {
    return await withServers({ mockMode: 'default', mockPort: 8271, shimPort: 8272, shimEnv: { SHIM_REQUEST_TIMEOUT_MS: '10000' } }, async () => {
      const filler = '0123456789abcdef'.repeat(128)
      const messages = []
      for (let index = 0; index < 40; index += 1) {
        messages.push({ role: 'user', content: [{ type: 'text', text: `context user ${index}: ${filler}` }] })
        messages.push({ role: 'assistant', content: [{ type: 'text', text: `context assistant ${index}: ${filler}` }] })
      }
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_large_context', name: 'Bash', input: { command: 'ls -la' } }] })
      messages.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_large_context', content: 'listing complete' },
        { type: 'text', text: '<system-reminder>internal note</system-reminder>\ncreate a file called large-context.txt with the text final payload' },
      ]})
      const res = await fetch('http://127.0.0.1:8272/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ignored', stream: false, messages,
          tools: [{ name: 'Bash', description: 'Run shell commands', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
        }),
      })
      const body = await res.json()
      const toolUse = body?.content?.find(block => block?.type === 'tool_use')
      if (!toolUse?.input?.command) throw new Error(`Expected tool_use, got ${JSON.stringify(body)}`)
      await runBashInDir(dir, toolUse.input.command)
      const content = await readFile(path.join(dir, 'large-context.txt'), 'utf8')
      const pass = content === 'final payload'
      return { input: 'large context + tool_result continuation create-file request', expected: 'synthetic tool_use still targets final user text', actual: `content=${JSON.stringify(content)} messageCount=${messages.length}`, pass }
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main() {
  const tests = [
    testTimeoutHandling,
    testMalformedJsonHandling,
    testRateLimitHandling,
    testStreamingGarbageHandling,
    testInterruptedStreamingCancelsUpstream,
    testScriptScaffoldFallback,
    testLargeContextContinuationFallback,
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
  console.log(JSON.stringify({ results, failedCount: failed.length }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

await main()
