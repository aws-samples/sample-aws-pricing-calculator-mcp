const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canRehydrate } = require('../lib/lint/can-rehydrate');

const FIXTURES = path.join(__dirname, 'fixtures', 'can-rehydrate');

function loadFixture(name) {
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  const perSvcDefs = new Map(Object.entries(data.perServiceDefinitions || {}));
  // Fixtures don't ship a manifest. The only predicate that consults
  // manifest is checkFlattenedSubService (top-level peer detected as a
  // sub-service). None of these four fixtures has a top-level service
  // whose manifest entry has subType === 'subService', so an empty
  // manifest is observationally equivalent.
  return { savedBlob: data.savedBlob, manifest: new Map(), perServiceDefinitions: perSvcDefs };
}

describe('canRehydrate against real fixtures', () => {
  it('Lambda editable fixture lints as editable', () => {
    const r = canRehydrate(loadFixture('lambda-editable.json'));
    assert.equal(r.status, 'editable', JSON.stringify(r.services[0]?.failures));
  });

  it('EC2 (ec2Enhancement) editable fixture lints as editable', () => {
    const r = canRehydrate(loadFixture('ec2-editable.json'));
    assert.equal(r.status, 'editable', JSON.stringify(r.services[0]?.failures));
  });

  it('SNS sub-service envelope: parent uses templateId path, child resolves via templates string array', () => {
    const r = canRehydrate(loadFixture('sns-editable.json'));
    assert.equal(r.status, 'editable', JSON.stringify(r.services.map(s => ({code: s.serviceCode, fails: s.failures}))));
    // Locks in the templateId fix: parent and child both editable, both zero failures.
    // If checkTemplateExistence drops its `definition.templateId === want` short-circuit,
    // the parent goes read-only and this test fails with a precise diagnostic.
    const parent = r.services.find(s => s.parentId === null);
    const child = r.services.find(s => s.parentId !== null);
    assert.ok(parent, 'expected a parent service in r.services');
    assert.ok(child, 'expected a child service in r.services');
    assert.equal(parent.status, 'editable');
    assert.equal(child.status, 'editable');
    assert.equal(parent.failures.length, 0);
    assert.equal(child.failures.length, 0);
  });

  it('eC2Next read-only fixture lints as read-only via template-existence', () => {
    const r = canRehydrate(loadFixture('ec2next-readonly.json'));
    assert.equal(r.status, 'read-only');
    assert.ok(r.services[0].failures.find(f => f.predicate === 'template-existence'));
  });
});
