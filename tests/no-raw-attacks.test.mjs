import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collectFiles(directory, extension) {
  const entries = await readdir(directory, { withFileTypes:true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(absolutePath);
    }
  }

  return files;
}

const files = [
  ...await collectFiles(path.join(repositoryRoot, 'functions'), '.js'),
  ...await collectFiles(path.join(repositoryRoot, 'migrations'), '.sql'),
  path.join(repositoryRoot, 'schema.sql')
];

const forbiddenPatterns = [
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+["`[]?attacks\b/i,
  /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`[]?attacks\b/i,
  /\bON\s+["`[]?attacks\s*\(/i
];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(
      source,
      pattern,
      `${path.relative(repositoryRoot, file)} must not depend on the legacy attacks table`
    );
  }
}

const schema = await readFile(path.join(repositoryRoot, 'schema.sql'), 'utf8');
for (const column of [
  'respect_earned',
  'respect_lost',
  'attack_detail_complete',
  'attack_detail_rows',
  'chain_bonus_hits_in',
  'chain_bonus_score_in',
  'chain_bonus_respect_lost_in'
]) {
  assert.match(schema, new RegExp(`\\b${column}\\b`), `schema.sql must define ${column}`);
}

console.log('Raw-attack storage regression tests passed.');
