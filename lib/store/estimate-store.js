// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const EstimateBuilder = require('../aws/estimate-builder');

// In-process, non-durable store. State is lost when the process exits.
// Each get() returns a fresh hydrated EstimateBuilder so callers can mutate
// without polluting the stored snapshot or other concurrent readers.
class MemoryEstimateStore {
  constructor() {
    this._snapshots = new Map();
  }

  async get(id) {
    const snap = this._snapshots.get(id);
    if (!snap) return null;
    // Deep-clone via JSON so two callers each get an independent instance —
    // mutations through addService() must not bleed across concurrent gets.
    return EstimateBuilder.fromJSON(JSON.parse(JSON.stringify(snap)));
  }

  async put(estimate) {
    this._snapshots.set(estimate.id, estimate.toJSON());
  }

  async delete(id) {
    this._snapshots.delete(id);
  }
}

function createEstimateStore(env = process.env) {
  const kind = (env.ESTIMATES_STORE || 'memory').toLowerCase();
  if (kind === 'memory') return new MemoryEstimateStore();
  if (kind === 'dynamodb') {
    // Lazy require: this file pulls in the AWS SDK at the top. We keep that
    // off the require graph for memory-store users (the default), so the
    // optional peer dep stays optional and esbuild --external: works.
    // nosemgrep: lazy-load-module
    const { DynamoEstimateStore } = require('./estimate-store-dynamodb');
    return new DynamoEstimateStore({
      tableName: env.ESTIMATES_TABLE,
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION,
      ttlSeconds: env.ESTIMATES_TTL_SECONDS ? Number(env.ESTIMATES_TTL_SECONDS) : undefined,
    });
  }
  throw new Error(`Unknown ESTIMATES_STORE: "${kind}". Valid: "memory", "dynamodb".`);
}

module.exports = { MemoryEstimateStore, createEstimateStore };
