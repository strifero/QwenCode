import http from 'node:http'

const port = parseInt(process.env.MOCK_OLLAMA_PORT || '8121', 10)
const mode = process.env.MOCK_OLLAMA_MODE || 'delay'
const delayMs = parseInt(process.env.MOCK_OLLAMA_DELAY_MS || '3000', 10)
const streamChunkDelayMs = parseInt(process.env.MOCK_OLLAMA_STREAM_DELAY_MS || '200', 10)

const stats = {
  totalRequests: 0,
  abortedRequests: 0,
  completedStreamingRequests: 0,
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/chat' && req.method === 'POST') {
    stats.totalRequests += 1

    if (mode === 'delay') {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'mock',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: 'mock delayed response' },
          done: true,
          done_reason: 'stop',
          eval_count: 3,
          prompt_eval_count: 3,
        }),
      )
      return
    }

    if (mode === 'malformed-json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{not valid json')
      return
    }

    if (mode === 'rate-limit') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded' }))
      return
    }

    if (mode === 'stream-garbage') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('not-json\n')
      res.write('still-not-json\n')
      res.end()
      return
    }

    if (mode === 'stream-slow') {
      let endedNormally = false
      req.on('close', () => {
        if (!endedNormally) stats.abortedRequests += 1
      })

      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      for (let index = 0; index < 100; index += 1) {
        if (req.destroyed || res.destroyed) return
        res.write(
          `${JSON.stringify({
            model: 'mock',
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: `chunk-${index}` },
            done: false,
          })}\n`,
        )
        await new Promise(resolve => setTimeout(resolve, streamChunkDelayMs))
      }
      endedNormally = true
      stats.completedStreamingRequests += 1
      res.end(
        `${JSON.stringify({
          model: 'mock',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: 'done' },
          done: true,
          done_reason: 'stop',
          eval_count: 4,
          prompt_eval_count: 3,
        })}\n`,
      )
      return
    }

    if (mode === 'script-json') {
      const content =
        process.env.MOCK_OLLAMA_SCRIPT_TEXT ||
        "```bash\nmkdir -p src\ncat > src/app.py <<'EOF'\nprint(\"hello\")\nEOF\ncat > README.md <<'EOF'\n# Demo\nEOF\n```"
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'mock',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content },
          done: true,
          done_reason: 'stop',
          eval_count: 8,
          prompt_eval_count: 4,
        }),
      )
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        model: 'mock',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' },
        done: true,
        done_reason: 'stop',
        eval_count: 1,
        prompt_eval_count: 1,
      }),
    )
    return
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, mode, delayMs }))
    return
  }

  if (req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, mode, ...stats }))
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.error(`[mock-ollama] listening on http://127.0.0.1:${port} (${mode})`)
})
