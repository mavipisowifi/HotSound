'use strict';

/**
 * Test runner.
 *
 * Wraps the Electron test modes and requires the run to actually print its
 * success marker. Exit code alone is not enough: a run that quits early (for
 * instance because another instance holds the single-instance lock) exits 0
 * without testing anything, which must count as a failure.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

// Required from Node, the electron package resolves to the binary path.
const electronBinary = require('electron');

const MODES = {
  smoke: { flag: '--smoke-test', marker: 'SMOKE OK', label: 'render + layout smoke test' },
  e2e: { flag: '--e2e-test', marker: 'E2E OK', label: 'audio / slots / waveform / persistence' }
};

const TIMEOUT_MS = 120000;

function runMode(mode) {
  const { flag, marker } = MODES[mode];
  return new Promise((resolve) => {
    const child = spawn(electronBinary, ['.', flag], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const collect = (buf) => {
      output += buf.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ mode, ok: false, reason: `timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const sawMarker = output.includes(marker);
      const clean = /GPU state invalid|command_buffer_proxy_impl/.test(output)
        ? output.replace(/\n*\[[^\]]*GPU state invalid[^\n]*/g, '').replace(/\[[^\]]*command_buffer_proxy_impl[^\n]*/g, '')
        : output;
      const noisy = clean.split('\n').filter((l) => l.trim() && !/^\s*$/.test(l));
      resolve({
        mode,
        ok: code === 0 && sawMarker,
        reason: sawMarker ? `exit ${code}` : `no "${marker}" in output (exit ${code})`,
        noise: noisy.slice(0, 4)
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ mode, ok: false, reason: `spawn failed: ${err.message}` });
    });
  });
}

async function main() {
  const arg = (process.argv[2] || 'both').toLowerCase();
  const wanted = arg === 'both' ? ['smoke', 'e2e'] : [arg];
  for (const m of wanted) {
    if (!MODES[m]) {
      console.error(`Unknown test mode "${m}". Use: smoke | e2e | both`);
      process.exit(2);
    }
  }

  const results = [];
  for (const m of wanted) {
    console.log(`\n=== ${MODES[m].label} (${m}) ===`);
    const res = await runMode(m);
    results.push(res);
    console.log(res.ok ? `--- ${m}: PASS ---` : `--- ${m}: FAIL (${res.reason}) ---`);
  }

  console.log('\n=== summary ===');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.mode.padEnd(6)} ${r.ok ? '' : r.reason}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${failed.length} test suite(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll test suites passed.');
}

main();
