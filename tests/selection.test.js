import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runCliAndCaptureSummary(workdir) {
  return new Promise((resolve, reject) => {
    const cliPath = path.resolve(__dirname, '..', 'add-gl-quotes-to-tsv-files-cli.js');
    const child = spawn(process.execPath, [cliPath, '-w', workdir, '--verbose'], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, SUMMARY_ONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const onLine = (line) => {
      // Look for the concise summary line
      if (/^Summary for .*twl_GEN\.tsv:/.test(line)) {
        const m = line.match(/to-generate=(\d+).*total=(\d+)/);
        if (m) {
          resolved = true;
          resolve({ toGenerate: Number(m[1]), total: Number(m[2]), line });
        }
      }
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      stdout.split(/\r?\n/).forEach(onLine);
    });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`CLI exited before emitting summary. code=${code}\nstdout=\n${stdout}\nstderr=\n${stderr}`));
      }
    });
  });
}

test('selection logic counts QUOTE_NOT_FOUND and empty GLQuote correctly', async () => {
  const { toGenerate, total, line } = await runCliAndCaptureSummary(path.resolve(__dirname, '..', 'fixtures', 'selection'));
  // In our fixture: 3 missing (rowA empty GLQuote, rowB GLQuote=QUOTE_NOT_FOUND, rowC OrigWords=QUOTE_NOT_FOUND), total includes header so expect 6
  assert.equal(total, 6, `Expected total=6 but saw: ${line}`);
  assert.equal(toGenerate, 3, `Expected to-generate=3 but saw: ${line}`);
});
