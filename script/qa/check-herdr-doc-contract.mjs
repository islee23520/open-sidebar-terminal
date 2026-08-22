#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const README_PATH = path.join(ROOT, 'README.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function getArgs(argv) {
  const args = { selfTest: false, evidencePath: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--self-test') {
      args.selfTest = true;
      continue;
    }
    if (token === '--evidence') {
      args.evidencePath = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token.startsWith('--evidence=')) {
      args.evidencePath = token.slice('--evidence='.length) || null;
      continue;
    }
  }
  return args;
}

function isHerdrCommand(key) {
  return key === 'ulw.attachHerdrSession' || key === 'ulw.detachHerdrSession';
}

function isHerdrSetting(key) {
  return key.startsWith('ulw.herdr.');
}

function collectManifestContracts(pkg) {
  const commands = (pkg?.contributes?.commands ?? [])
    .map((entry) => entry?.command)
    .filter((value) => typeof value === 'string' && isHerdrCommand(value));
  const settings = Object.keys(pkg?.contributes?.configuration?.properties ?? {})
    .filter((key) => isHerdrSetting(key));
  const keys = uniqueSorted([...commands, ...settings]);
  return { commands: uniqueSorted(commands), settings: uniqueSorted(settings), keys };
}

function stripHtmlComments(markdown) {
  return markdown.replace(/<!--[\s\S]*?-->/g, '');
}

function extractTableRows(markdown) {
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.includes('|'))
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
}

function collectDocumentedIds(markdown) {
  const cleaned = stripHtmlComments(markdown);
  const ids = new Set();
  const commandRe = /`(ulw\.[a-zA-Z0-9.]+)`/g;
  for (const row of extractTableRows(cleaned)) {
    const cells = row.split('|').map((cell) => cell.trim());
    const first = cells[1] ?? '';
    if (/^`ulw\.[^`]+`$/.test(first)) {
      ids.add(first.slice(1, -1));
    }
  }
  let match;
  while ((match = commandRe.exec(cleaned))) {
    ids.add(match[1]);
  }
  return [...ids].filter((id) => isHerdrCommand(id) || isHerdrSetting(id) || id.startsWith('ulw.herd'));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function diffLists(expected, actual) {
  const missing = expected.filter((value) => !actual.includes(value));
  const extra = actual.filter((value) => !expected.includes(value));
  return { missing, extra };
}

function buildRows(manifestKeys, docKeys) {
  const keys = uniqueSorted([...manifestKeys, ...docKeys]);
  return keys.map((key) => ({
    key,
    manifest_present: manifestKeys.includes(key),
    docs_present: docKeys.includes(key),
    manifest_to_docs: docKeys.includes(key),
    docs_to_manifest: manifestKeys.includes(key),
    matched: manifestKeys.includes(key) && docKeys.includes(key),
  }));
}

function buildReport(pkg, readme, agents) {
  const manifest = collectManifestContracts(pkg);
  const docs = uniqueSorted([...collectDocumentedIds(readme), ...collectDocumentedIds(agents)]);
  const rows = buildRows(manifest.keys, docs);
  const missing = rows.filter((row) => row.manifest_present && !row.docs_present).map((row) => row.key);
  const extra = rows.filter((row) => row.docs_present && !row.manifest_present).map((row) => row.key);
  const ok = missing.length === 0 && extra.length === 0;
  return {
    ok,
    manifest: { commands: manifest.commands, settings: manifest.settings, keys: manifest.keys },
    docs: { keys: docs },
    rows,
    diffs: { missing, extra },
  };
}

function formatReport(report) {
  const lines = [];
  lines.push('HERDR DOC CONTRACT');
  lines.push('| key | manifest->docs | docs->manifest | matched |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of report.rows) {
    lines.push(
      `| ${row.key} | ${row.manifest_to_docs ? 'true' : 'false'} | ${row.docs_to_manifest ? 'true' : 'false'} | ${row.matched ? 'true' : 'false'} |`,
    );
  }
  if (!report.ok) {
    if (report.diffs.missing.length) {
      lines.push(`missing manifest docs: ${report.diffs.missing.join(', ')}`);
    }
    if (report.diffs.extra.length) {
      lines.push(`extra documented ids: ${report.diffs.extra.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function writeEvidence(evidencePath, payload) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function runCheck({ pkg, readme, agents }) {
  const report = buildReport(pkg, readme, agents);
  const output = formatReport(report);
  console.log(output);
  return report;
}

function selfTest() {
  const pkg = readJson(PACKAGE_PATH);
  const readme = readText(README_PATH);
  const agents = readText(AGENTS_PATH);
  const original = buildReport(pkg, readme, agents);

  const mutatedExtra = buildReport(
    pkg,
    `${readme}\n| \`ulw.herdFake\` | Adversarial fake command |`,
    agents,
  );
  const mutatedCommentedOut = buildReport(
    pkg,
    readme.replace(
      '| `ulw.herdr.socketPath` | empty | Optional Herdr socket path; ignored when a named session is configured |',
      '<!-- | `ulw.herdr.socketPath` | empty | Optional Herdr socket path; ignored when a named session is configured | -->',
    ),
    agents,
  );
  const mutatedMissingManifest = buildReport(
    {
      ...pkg,
      contributes: {
        ...pkg.contributes,
        commands: pkg.contributes.commands.filter((entry) => entry.command !== 'ulw.attachHerdrSession'),
      },
    },
    readme,
    agents,
  );

  const rejected = !mutatedExtra.ok && !mutatedCommentedOut.ok && !mutatedMissingManifest.ok;
  const passed = original.ok && rejected;
  const payload = {
    selfTest: true,
    originalOk: original.ok,
    mutatedRejected: rejected,
    passed,
    original,
    mutations: {
      fakeDocumentedExtraRejected: !mutatedExtra.ok,
      commentedOutRowRejected: !mutatedCommentedOut.ok,
      missingManifestKeyRejected: !mutatedMissingManifest.ok,
    },
  };
  console.log(formatReport(original));
  console.log(`self-test fake extra rejected: ${mutatedExtra.ok ? 'no' : 'yes'}`);
  console.log(`self-test commented-out row rejected: ${mutatedCommentedOut.ok ? 'no' : 'yes'}`);
  console.log(`self-test missing manifest key rejected: ${mutatedMissingManifest.ok ? 'no' : 'yes'}`);
  return payload;
}

const args = getArgs(process.argv);
const pkg = readJson(PACKAGE_PATH);
const readme = readText(README_PATH);
const agents = readText(AGENTS_PATH);

if (args.selfTest) {
  const payload = selfTest();
  if (args.evidencePath) writeEvidence(args.evidencePath, payload);
  process.exit(payload.passed ? 0 : 1);
}

const report = runCheck({ pkg, readme, agents });
const payload = {
  selfTest: false,
  manifest_docs_match: report.ok,
  manifest: report.manifest,
  docs: report.docs,
  rows: report.rows,
  diffs: report.diffs,
};
if (args.evidencePath) writeEvidence(args.evidencePath, payload);
process.exit(report.ok ? 0 : 1);
