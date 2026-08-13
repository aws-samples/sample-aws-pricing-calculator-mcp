const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCatalog, getEntry, listVerified, validateAgainstSchema } = require('../lib/lint/catalog');

const FIXTURES = path.join(__dirname, 'fixtures', 'catalog');

describe('catalog loader', () => {
  it('throws on schema-invalid entry when strict=true', () => {
    // The default mode is strict — the invalid fixture must abort the load.
    // The error message includes "Invalid catalog entry <file>: ..." with the
    // missing-property details from Ajv. Match on lastVerifiedAt since that's
    // the load-bearing missing field for the invalid fixture.
    assert.throws(
      () => loadCatalog(FIXTURES, { strict: true }),
      /lastVerifiedAt/
    );
  });

  it('loads valid entries and skips invalid ones when strict=false', () => {
    const cat = loadCatalog(FIXTURES, { strict: false });
    // The valid fixture lands in the map; the invalid one is logged + skipped.
    assert.equal(cat.size, 1);
    assert.ok(cat.has('aWSLambda'));
    assert.ok(!cat.has('badEntry'));
  });

  it('returns Map keyed by serviceCode', () => {
    const cat = loadCatalog(FIXTURES, { strict: false });
    const entry = cat.get('aWSLambda');
    assert.equal(entry.displayName, 'AWS Lambda');
  });

  it('skips a file that vanishes between readdir and read (TOCTOU), even in strict mode', () => {
    // Regression: loadCatalog scans a directory (readdirSync) then reads each
    // entry (readFileSync). A concurrent writer can remove a file in that
    // window — a stale listing entry, never a real catalog error. Simulate it
    // deterministically by making readdir report a "ghost.json" that isn't on
    // disk, so the subsequent read throws ENOENT.
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-toctou-'));
    const realReaddir = fs.readdirSync;
    try {
      fs.copyFileSync(path.join(FIXTURES, 'valid-entry.json'), path.join(tmp, 'valid-entry.json'));
      fs.readdirSync = (d, ...rest) => {
        const listing = realReaddir.call(fs, d, ...rest);
        return d === tmp ? [...listing, 'ghost.json'] : listing;
      };
      const cat = loadCatalog(tmp, { strict: true });
      assert.ok(cat.has('aWSLambda'), 'the valid entry still loads');
      assert.equal(cat.size, 1, 'the vanished ghost.json is skipped, not counted');
    } finally {
      fs.readdirSync = realReaddir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('getEntry', () => {
  it('returns the entry for a known service', () => {
    const cat = loadCatalog(FIXTURES, { strict: false });
    assert.equal(getEntry(cat, 'aWSLambda').displayName, 'AWS Lambda');
  });

  it('returns undefined for an unknown service', () => {
    const cat = loadCatalog(FIXTURES, { strict: false });
    assert.equal(getEntry(cat, 'doesNotExist'), undefined);
  });
});

describe('listVerified', () => {
  it('returns only entries with status === "verified"', () => {
    const cat = loadCatalog(FIXTURES, { strict: false });
    const verified = listVerified(cat);
    // Both fixtures have status unverified or verified-but-invalid; expect 0.
    assert.equal(verified.length, 0);
  });
});

describe('validateAgainstSchema', () => {
  it('returns null for a valid entry', () => {
    const fs = require('node:fs');
    const valid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid-entry.json'), 'utf8'));
    assert.equal(validateAgainstSchema(valid), null);
  });

  it('returns error array for an invalid entry', () => {
    const fs = require('node:fs');
    const invalid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'invalid-entry.json'), 'utf8'));
    const errors = validateAgainstSchema(invalid);
    assert.ok(Array.isArray(errors));
    assert.ok(errors.length > 0);
  });
});
