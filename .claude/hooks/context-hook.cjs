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
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.claude/.supermemory-claude/config.json'), 'utf8'));
    if (cfg.repoContainerTag) repoTag = cfg.repoContainerTag;
  } catch {}
  const personalTag = `claudecode_project_${crypto.createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
  const projectName = cwd.split('/').pop() || 'project';
  return { repoTag, personalTag, projectName };
}

function formatProfile(result) {
  if (!result) return null;
  const { profile, searchResults } = result;
  const items = [
    ...(Array.isArray(profile?.static) ? profile.static : []),
    ...(Array.isArray(profile?.dynamic) ? profile.dynamic : []),
    ...(Array.isArray(searchResults) ? searchResults.map((r) => (typeof r === 'string' ? r : r.content)) : []),
  ].filter(Boolean).slice(0, 5);
  return items.length ? items.map((i) => `- ${i}`).join('\n') : null;
}

async function main() {
  const apiKey = process.env.SUPERMEMORY_CC_API_KEY || process.env.SUPERMEMORY_API_KEY;

  if (!apiKey) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            '<supermemory-status>\nSet SUPERMEMORY_CC_API_KEY to enable persistent memory.\n</supermemory-status>',
        },
      }) + '\n',
    );
    return;
  }

  try {
    bootstrap();
  } catch {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' } }) + '\n',
    );
    return;
  }

  const SM = require('supermemory');
  const Supermemory = SM.default || SM;
  const client = new Supermemory({ apiKey });

  const input = await readStdin();
  const cwd = input.cwd || process.cwd();
  const { repoTag, personalTag, projectName } = getContainerTags(cwd);

  const [personal, repo] = await Promise.allSettled([
    client.profile({ containerTag: personalTag, q: projectName }),
    client.profile({ containerTag: repoTag, q: projectName }),
  ]);

  const parts = [];
  const personalCtx = personal.status === 'fulfilled' ? formatProfile(personal.value) : null;
  const repoCtx = repo.status === 'fulfilled' ? formatProfile(repo.value) : null;

  if (personalCtx) parts.push(`### Personal Memories\n${personalCtx}`);
  if (repoCtx) parts.push(`### Project Knowledge\n${repoCtx}`);

  const additionalContext = parts.length
    ? `<supermemory-context>\n${parts.join('\n\n')}\n</supermemory-context>`
    : '<supermemory-context>\nNo previous memories found. Memories will be saved as you work.\n</supermemory-context>';

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`Supermemory error: ${err.message}\n`);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `<supermemory-status>\nFailed to load memories: ${err.message}\nSession continues without memory context.\n</supermemory-status>`,
      },
    }) + '\n',
  );
});
