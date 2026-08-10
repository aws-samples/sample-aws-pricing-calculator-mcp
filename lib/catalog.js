const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA = require('../catalog/schema.json');
// nosemgrep: ajv-allerrors-true
// allErrors:true is safe here: catalog files are checked-in maintainer
// content, not user input. The DoS concern (unbounded error allocation) only
// applies when ajv validates attacker-controlled JSON in a request path.
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

function validateAgainstSchema(entry) {
  const ok = validate(entry);
  if (ok) return null;
  return validate.errors.map(e => ({
    path: e.instancePath,
    keyword: e.keyword,
    message: e.message,
    params: e.params,
  }));
}

function loadCatalog(dir, { strict = true } = {}) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(dir, file);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      // TOCTOU: the file was present at readdir time but is gone now — a
      // concurrent writer (e.g. a catalog edit/deploy, or a parallel test
      // that creates and cleans up a fixture) removed it between the
      // directory listing and this read. A stale listing entry is never a
      // real catalog error, so skip it rather than crash the scan.
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const entry = JSON.parse(raw);
    const errors = validateAgainstSchema(entry);
    if (errors) {
      const summary = `Invalid catalog entry ${file}: ${errors.map(e => `${e.path} ${e.message}`).join('; ')}`;
      if (strict) throw new Error(summary);
      console.error(summary);
      continue;
    }
    out.set(entry.serviceCode, entry);
  }
  return out;
}

function getEntry(catalog, serviceCode) {
  return catalog.get(serviceCode);
}

function listVerified(catalog) {
  return [...catalog.values()].filter(e => e.status === 'verified');
}

module.exports = { loadCatalog, getEntry, listVerified, validateAgainstSchema };
