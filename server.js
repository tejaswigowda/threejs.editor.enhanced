const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT  = parseInt(process.argv[2] || '5500', 10);
const ROOT  = path.join(__dirname, 'docs');
const DEV   = process.env.DEV === '1' || process.argv.includes('--dev');

const MIME = {
  '.html' : 'text/html; charset=utf-8',
  '.js'   : 'application/javascript; charset=utf-8',
  '.mjs'  : 'application/javascript; charset=utf-8',
  '.css'  : 'text/css; charset=utf-8',
  '.wasm' : 'application/wasm',
  '.json' : 'application/json; charset=utf-8',
  '.png'  : 'image/png',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.gif'  : 'image/gif',
  '.svg'  : 'image/svg+xml',
  '.ico'  : 'image/x-icon',
  '.mp4'  : 'video/mp4',
  '.webm' : 'video/webm',
  '.mp3'  : 'audio/mpeg',
  '.wav'  : 'audio/wav',
};

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// ── Security headers for API responses ────────────────────────────────────────
// Prevent caching and exposure of sensitive data
function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

// ── API Proxy Handlers (Dev Mode) ──────────────────────────────────────────

async function handleApiModels(res) {
  const models = [
    // WebLLM (built-in)
    { id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5-Coder 1.5B (~1 GB)', source: 'webllm', vram_required_MB: 1024 },
    { id: 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC',   label: 'Qwen2.5-Coder 7B (~4.5 GB)', source: 'webllm', vram_required_MB: 4608 },
    { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',       label: 'Llama 3.2 1B (~900 MB)', source: 'webllm', vram_required_MB: 900 },
  ];

  // Ollama integration (if running locally)
  if (DEV) {
    try {
      const ollamaRes = await fetch('http://127.0.0.1:11434/api/tags', { timeout: 2000 });
      if (ollamaRes.ok) {
        const data = await ollamaRes.json();
        (data.models || []).forEach(m => {
          models.push({
            id: `ollama:${m.name}`,
            label: `${m.name} (Ollama)`,
            source: 'ollama',
            vram_required_MB: m.size ? Math.round(m.size / 1024 / 1024) : 2048,
            endpoint: 'http://127.0.0.1:11434'
          });
        });
      }
    } catch (e) {
      // Ollama not running, skip
    }

    // OpenAI API (if OPENAI_API_KEY env var set)
    if (process.env.OPENAI_API_KEY) {
      models.push({
        id: 'gpt-4',
        label: 'OpenAI GPT-4 (API)',
        source: 'openai',
        vram_required_MB: 0
      });
      models.push({
        id: 'gpt-4-turbo',
        label: 'OpenAI GPT-4 Turbo (API)',
        source: 'openai',
        vram_required_MB: 0
      });
      models.push({
        id: 'gpt-3.5-turbo',
        label: 'OpenAI GPT-3.5 Turbo (API)',
        source: 'openai',
        vram_required_MB: 0
      });
    }

    // Claude API (Anthropic) - if ANTHROPIC_API_KEY env var set
    if (process.env.ANTHROPIC_API_KEY) {
      models.push({
        id: 'claude-opus-4-8',
        label: 'Claude Opus 4.8 (Anthropic)',
        source: 'anthropic',
        vram_required_MB: 0
      });
      models.push({
        id: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6 (Anthropic)',
        source: 'anthropic',
        vram_required_MB: 0
      });
      models.push({
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5 (Anthropic)',
        source: 'anthropic',
        vram_required_MB: 0
      });
    }
  }

  setSecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models, devMode: DEV }, null, 2));
}

// ── SSE streaming helpers (cloud token-by-token, like local WebLLM) ──────────
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}
function sseSend(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function sseDone(res) { res.write('data: [DONE]\n\n'); res.end(); }

// Read an upstream provider response body line-by-line and forward each parsed
// delta to the client as a unified `data: {"delta":"…"}` SSE event.
async function relayProviderStream(res, upstream, onLine) {
  sseInit(res);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        onLine(line, res);
      }
    }
    if (buf.trim()) onLine(buf, res);
  } catch (e) {
    console.error('[Stream Error]', e.message);
    sseSend(res, { error: 'stream interrupted' });
  }
  sseDone(res);
}

// Per-provider line → delta extractor. Ollama emits NDJSON; OpenAI and Claude
// emit SSE `data:` lines (OpenAI: choices[].delta.content; Claude:
// content_block_delta.delta.text).
function providerLineHandler(kind) {
  return (rawLine, res) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line) return;
    if (kind === 'ollama') {
      let o; try { o = JSON.parse(line); } catch { return; }
      const d = o.message?.content || '';
      if (d) sseSend(res, { delta: d });
      return;
    }
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let o; try { o = JSON.parse(payload); } catch { return; }
    if (kind === 'openai') {
      const d = o.choices?.[0]?.delta?.content || '';
      if (d) sseSend(res, { delta: d });
    } else if (kind === 'claude') {
      if (o.type === 'content_block_delta') {
        const d = o.delta?.text || '';
        if (d) sseSend(res, { delta: d });
      }
    }
  };
}

async function handleApiChat(req, res) {
  setSecurityHeaders(res);

  if (!DEV) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API mode disabled' }));
    return;
  }

  // Enforce Content-Type validation
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('application/json')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid Content-Type' }));
    return;
  }

  let body = '';
  let parseError = false;

  req.on('data', chunk => {
    body += chunk;
    // Limit request size to prevent abuse (1MB)
    if (body.length > 1024 * 1024) {
      req.pause();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request too large' }));
      parseError = true;
    }
  });

  req.on('end', async () => {
    if (parseError) return;

    try {
      const payload = JSON.parse(body);
      const { model, messages, temperature = 0.7, max_tokens = 2000 } = payload;
      const wantStream = payload.stream === true;

      // Validate model parameter
      if (!model || typeof model !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid model parameter' }));
        return;
      }

      // Validate messages parameter
      if (!Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid messages parameter' }));
        return;
      }

      // Route to appropriate API
      if (model.startsWith('ollama:')) {
        const modelName = model.slice(7);

        if (wantStream) {
          let upstream;
          try {
            upstream = await fetch('http://127.0.0.1:11434/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: modelName, messages, stream: true })
            });
          } catch (e) {
            console.error('[Ollama Error]', e.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Ollama service error' }));
            return;
          }
          if (!upstream.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Ollama service error' }));
            return;
          }
          await relayProviderStream(res, upstream, providerLineHandler('ollama'));
          return;
        }

        try {
          const ollamaRes = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, messages, stream: false }),
            timeout: 30000
          });
          const data = await ollamaRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (e) {
          console.error('[Ollama Error]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ollama service error' }));
        }
      } else if (model.startsWith('gpt-')) {
        // Validate that API key is configured before proceeding
        if (!process.env.OPENAI_API_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI not configured' }));
          return;
        }

        if (wantStream) {
          let upstream;
          try {
            upstream = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
              },
              body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true })
            });
          } catch (e) {
            console.error('[OpenAI Error]', e.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'OpenAI service error' }));
            return;
          }
          if (!upstream.ok) {
            console.error('[OpenAI Error]', upstream.status);
            const statusErr = { 401: 'Authentication failed', 429: 'Rate limited', 500: 'Service error' }[upstream.status] || 'API error';
            res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: statusErr }));
            return;
          }
          await relayProviderStream(res, upstream, providerLineHandler('openai'));
          return;
        }

        try {
          const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({ model, messages, temperature, max_tokens }),
            timeout: 30000
          });

          // Don't expose raw OpenAI error responses (they might contain sensitive info)
          if (!openaiRes.ok) {
            const errText = await openaiRes.text();
            console.error('[OpenAI Error]', openaiRes.status);
            // Return generic error message
            const statusErr = { 401: 'Authentication failed', 429: 'Rate limited', 500: 'Service error' }[openaiRes.status] || 'API error';
            res.writeHead(openaiRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: statusErr }));
            return;
          }

          const data = await openaiRes.json();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        } catch (e) {
          console.error('[OpenAI Error]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'OpenAI service error' }));
        }
      } else if (model.startsWith('claude-')) {
        // Validate that API key is configured before proceeding
        if (!process.env.ANTHROPIC_API_KEY) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Claude not configured' }));
          return;
        }

        try {
          // Claude API 2023-06-01: requires top-level 'system' parameter, not in messages array
          let systemPrompt = '';
          const claudeMessages = [];

          for (const msg of messages) {
            if (msg.role === 'system') {
              systemPrompt = msg.content;
            } else {
              claudeMessages.push({
                role: msg.role,
                content: msg.content
              });
            }
          }

          const requestBody = {
            model: model,
            max_tokens: max_tokens || 2048,
            messages: claudeMessages
          };

          // Newer Claude models (Opus 4.8+) deprecate the temperature parameter.
          // Only include it for models that still accept it.
          if (!/^claude-opus-4-[78]/.test(model)) {
            requestBody.temperature = temperature;
          }

          // Add system parameter if we have system content
          if (systemPrompt) {
            requestBody.system = systemPrompt;
          }

          console.log('[Claude Request]', JSON.stringify({ model, messageCount: claudeMessages.length, maxTokens: max_tokens, hasSystem: !!systemPrompt }));

          if (wantStream) {
            const streamBody = { ...requestBody, stream: true };
            let upstream;
            const maxStreamRetries = 5;
            for (let attempt = 0; attempt <= maxStreamRetries; attempt++) {
              upstream = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'x-api-key': process.env.ANTHROPIC_API_KEY,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json'
                },
                body: JSON.stringify(streamBody)
              });
              if (upstream.status !== 429 || attempt === maxStreamRetries) break;
              const retryAfter = parseFloat(upstream.headers.get('retry-after'));
              const waitMs = Number.isFinite(retryAfter)
                ? Math.ceil(retryAfter * 1000)
                : Math.min(2000 * Math.pow(2, attempt), 30000);
              console.warn(`[Claude 429] rate limited (stream), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxStreamRetries})`);
              await new Promise(r => setTimeout(r, waitMs));
            }
            if (!upstream.ok) {
              const errData = await upstream.json().catch(() => ({}));
              console.error('[Claude Error]', upstream.status, 'Model:', model, 'Error:', errData.error || errData);
              const statusErr = { 401: 'Authentication failed', 404: 'Model not found', 429: 'Rate limited', 500: 'Service error' }[upstream.status] || 'API error';
              const headers = { 'Content-Type': 'application/json' };
              const retryAfter = upstream.headers.get('retry-after');
              if (upstream.status === 429 && retryAfter) headers['Retry-After'] = retryAfter;
              res.writeHead(upstream.status, headers);
              res.end(JSON.stringify({ error: statusErr }));
              return;
            }
            await relayProviderStream(res, upstream, providerLineHandler('claude'));
            return;
          }

          // Retry on 429 (rate limit) with backoff, respecting retry-after header.
          let claudeRes;
          const maxRetries = 5;
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
              },
              body: JSON.stringify(requestBody),
              timeout: 30000
            });

            if (claudeRes.status !== 429 || attempt === maxRetries) break;

            // Honor server-provided retry-after (seconds); fall back to exponential backoff.
            const retryAfter = parseFloat(claudeRes.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter)
              ? Math.ceil(retryAfter * 1000)
              : Math.min(2000 * Math.pow(2, attempt), 30000);
            console.warn(`[Claude 429] rate limited, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, waitMs));
          }

          // Don't expose raw Claude error responses
          if (!claudeRes.ok) {
            const errData = await claudeRes.json().catch(() => ({}));
            console.error('[Claude Error]', claudeRes.status, 'Model:', model, 'Error:', errData.error || errData);
            const statusErr = { 401: 'Authentication failed', 404: 'Model not found', 429: 'Rate limited', 500: 'Service error' }[claudeRes.status] || 'API error';
            const headers = { 'Content-Type': 'application/json' };
            // Forward retry-after so the client can back off precisely.
            const retryAfter = claudeRes.headers.get('retry-after');
            if (claudeRes.status === 429 && retryAfter) headers['Retry-After'] = retryAfter;
            res.writeHead(claudeRes.status, headers);
            res.end(JSON.stringify({ error: statusErr }));
            return;
          }

          const data = await claudeRes.json();
          // Convert Claude response format to OpenAI-compatible format for consistent client handling
          const compatibleResponse = {
            id: data.id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: data.content[0].text
                },
                finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason
              }
            ]
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(compatibleResponse));
        } catch (e) {
          console.error('[Claude Error]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Claude service error' }));
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown model source' }));
      }
    } catch (e) {
      console.error('[Parse Error]', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
  });
}

async function handleApiHealth(res) {
  setSecurityHeaders(res);

  const health = { status: 'ok', devMode: DEV, services: {} };

  if (DEV) {
    try {
      const ollamaRes = await fetch('http://127.0.0.1:11434/api/tags', { timeout: 2000 });
      health.services.ollama = ollamaRes.ok ? 'running' : 'offline';
    } catch (e) {
      health.services.ollama = 'offline';
    }

    // Only indicate that OpenAI is configured, never expose the key or any details
    health.services.openai = process.env.OPENAI_API_KEY ? 'configured' : 'not configured';

    // Only indicate that Claude/Anthropic is configured, never expose the key or any details
    health.services.claude = process.env.ANTHROPIC_API_KEY ? 'configured' : 'not configured';
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  // WHATWG URL API (url.parse is non-standard and security-prone). Only the
  // pathname is needed for routing; a fixed base satisfies the absolute-URL
  // requirement since req.url is always an origin-relative path.
  const pathname = new URL(req.url, 'http://localhost').pathname;

  // ── API Routes (Dev Mode) ──────────────────────────────────────────────
  if (pathname === '/api/models' && req.method === 'GET') {
    handleApiModels(res);
    return;
  }
  if (pathname === '/api/chat' && req.method === 'POST') {
    handleApiChat(req, res);
    return;
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    handleApiHealth(res);
    return;
  }

  // ── Static File Serving ────────────────────────────────────────────────
  // Resolve URL to a file path inside docs/
  let urlPath = req.url.split('?')[0];          // strip query string
  if (urlPath === '/') urlPath = '/index.html';  // default document

  const filePath = path.join(ROOT, urlPath);

  // Security: prevent path traversal outside docs/
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    // ── Headers required for SharedArrayBuffer / cross-origin isolation ──
    res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    // Allow CDN resources (jsDelivr) to load inside the isolated context
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // ── Cache headers for PWA offline support ──
    const baseName = path.basename(filePath);
    if (baseName === 'service-worker.js' || baseName === 'manifest.json') {
      // Don't cache service worker and manifest to ensure updates
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (baseName === 'index.html') {
      // Cache index for short period to enable offline access
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // Cache app resources longer
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // Cache static assets long-term
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    res.setHeader('Content-Type',   mime(filePath));
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving docs/ at http://127.0.0.1:${PORT}`);
  if (DEV) {
    console.log('✓ Dev mode enabled');
    console.log('  /api/models  — List available models (WebLLM + Ollama + OpenAI + Claude)');
    console.log('  /api/chat    — Proxy chat requests to local/remote APIs');
    console.log('  /api/health  — Check health of external services');
    console.log('  • Ollama:     http://127.0.0.1:11434 (optional)');
    console.log('  • OpenAI:     OPENAI_API_KEY env var (optional)');
    console.log('  • Claude:     ANTHROPIC_API_KEY env var (optional)');
  }
  console.log('Press Ctrl+C to stop.');
});
