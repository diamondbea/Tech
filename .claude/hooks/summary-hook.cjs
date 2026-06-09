'use strict';

const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const HOOKS_DIR = __dirname;

function bootstrap() {
  if (!fs.existsSync(path.join(HOOKS_DIR, 'node_modules'))) {
    execSync('npm install --silent --prefer-offline', { cwd: HOOKS_DIR, stdio: 'pipe', timeout: 30000 });
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
    setTimeout(() => resolve({}), 5000);
  });
}

function getContainerTags(cwd) {
  let repoTag = `repo_${(cwd.split('/').pop() || 'project').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  let signalKeywords = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude/.supermemory-claude/config.json'), 'utf8'));
    if (cfg.repoContainerTag) repoTag = cfg.repoContainerTag;
    if (Array.isArray(cfg.signalKeywords)) signalKeywords = cfg.signalKeywords;
  } catch {}
  const personalTag = `claudecode_project_${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
  return { repoTag, personalTag, signalKeywords };
}

function parseTranscript(transcriptPath, signalKeywords) {
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }

  const messages = [];
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' && entry.type !== 'user') continue;
      const mc = entry.message?.content;
      const text = (Array.isArray(mc)
        ? mc.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
        : typeof mc === 'string' ? mc : ''
      ).trim();
      if (text) messages.push({ role: entry.type, text });
    } catch {}
  }

  if (!messages.length) return null;

  const chosen = signalKeywords.length
    ? messages.filter((m) => signalKeywords.some((kw) => m.text.toLowerCase().includes(kw.toLowerCase())))
    : messages;

  return (chosen.length ? chosen : messages).slice(-30).map((m) => `${m.role}: ${m.text}`).join('\n\n');
}

async function main() {
  const done = () => process.stdout.write(JSON.stringify({ continue: true }) + '\n');

  const apiKey = process.env.SUPERMEMORY_CC_API_KEY || process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) return done();

  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path;
  if (!transcriptPath) return done();

  const { repoTag, personalTag, signalKeywords } = getContainerTags(cwd);
  const content = parseTranscript(transcriptPath, signalKeywords);
  if (!content) return done();

  try { bootstrap(); } catch { return done(); }

  const SM = require('supermemory');
  const Supermemory = SM.default || SM;
  const client = new Supermemory({ apiKey });

  const metadata = {
    project: cwd.split('/').pop() || 'project',
    session_id: input.session_id || '',
    timestamp: new Date().toISOString(),
    source: 'claude-code',
  };

  await Promise.allSettled([
    client.add({ content, containerTag: personalTag, metadata }),
    client.add({ content, containerTag: repoTag, metadata }),
  ]);

  done();
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
});
