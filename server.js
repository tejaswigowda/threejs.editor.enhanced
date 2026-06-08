const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

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
  }

  setSecurityHeaders(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ models, devMode: DEV }, null, 2));
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
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(health, null, 2));
}

function mime(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

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
    console.log('  /api/models  — List available models (WebLLM + Ollama + OpenAI)');
    console.log('  /api/chat    — Proxy chat requests to local/remote APIs');
    console.log('  /api/health  — Check health of external services');
    console.log('  • Ollama:    http://127.0.0.1:11434 (optional)');
    console.log('  • OpenAI:    OPENAI_API_KEY env var (optional)');
  }
  console.log('Press Ctrl+C to stop.');
});
