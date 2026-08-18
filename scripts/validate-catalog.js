#!/usr/bin/env node
const path = require('node:path');
const { loadCatalog } = require('../lib/lint/catalog');

const dir = path.join(__dirname, '..', 'catalog', 'services');

try {
  const catalog = loadCatalog(dir, { strict: true });
  for (const code of [...catalog.keys()].sort()) {
    console.log(`OK   ${code}.json`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
