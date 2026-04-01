/**
 * publish.js
 * Usage: node scripts/publish.js
 * Runs: git add . && git commit -m "content update [ISO timestamp]" && git push
 * Streams all output to stdout. Exits with code 1 on failure.
 */

const { spawn } = require('child_process');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}\n${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function publish() {
  const timestamp = new Date().toISOString();
  const commitMessage = `content update [${timestamp}]`;

  console.log(`\n[publish] Starting publish at ${timestamp}`);
  console.log(`[publish] Repo root: ${repoRoot}\n`);

  try {
    console.log('[publish] Running: git add .');
    await runCommand('git', ['add', '.'], repoRoot);

    console.log(`\n[publish] Running: git commit -m "${commitMessage}"`);
    await runCommand('git', ['commit', '-m', commitMessage], repoRoot);

    console.log('\n[publish] Running: git push');
    await runCommand('git', ['push'], repoRoot);

    console.log('\n[publish] Done! Site published successfully.');
    process.exit(0);
  } catch (err) {
    console.error(`\n[publish] Failed: ${err.message}`);
    process.exit(1);
  }
}

publish();
