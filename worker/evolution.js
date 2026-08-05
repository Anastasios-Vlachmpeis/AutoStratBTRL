/**
 * Deterministic, data-only evolutionary proposal registry.
 *
 * This module deliberately contains no evaluator or dynamic execution.  It
 * creates immutable DSL documents which must still pass the normal research
 * and backtesting gates before they can consume any expensive compute.
 */
import { buildStrategyDNA, validateStrategyDNA } from "./dsl.js";
import { buildGeneratedStrategyDNA, DSL_FAMILIES } from "./dsl-generation.js";
import { deterministicTrialId } from "./research-contract.js";
import { INITIAL_UNIVERSE_SYMBOLS } from "./universe.js";

export const CHALLENGER_OPERATORS = Object.freeze([
  "parameter_perturbation",
  "feature_substitution",
  "subtree_replacement",
  "condition_add_remove",
  "exit_mutation",
  "universe_scope_mutation",
  "type_compatible_crossover",
]);

// Mulberry32, with all arithmetic deliberately made explicit and local.  A
// trial's stream never depends on worker timing or on a prior trial outcome.
function randomStream(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function trialSeed(contract, ordinal) {
  // Contract identity already includes the dataset/compiler/config.  Mixing
  // its hash makes changing any of those inputs change every proposal.
  const prefix = Number.parseInt(contract.contract_hash.slice(0, 8), 16) >>> 0;
  return (prefix ^ (Number(contract.seed) >>> 0) ^ Math.imul(ordinal + 1, 0x9E3779B1)) >>> 0;
}

function pick(random, values) { return values[Math.floor(random() * values.length)]; }
function integer(random, low, high) { return low + Math.floor(random() * (high - low + 1)); }
function decimal(random, low, high, places = 5) {
  const scale = 10 ** places;
  return Math.round((low + (high - low) * random()) * scale) / scale;
}
function clone(value) { return structuredClone(value); }

function sampledParams(family, random) {
  const common = { position_size: decimal(random, .25, 1, 3), cooldown_bars: integer(random, 0, 8) };
  if (family === "Dual average trend") {
    const fast = integer(random, 3, 20);
    return { ...common, fast, slow: integer(random, Math.max(fast + 2, 12), 80), threshold: decimal(random, .0002, .008, 5) };
  }
  if (family === "Residual reversion") return {
    ...common, lookback: integer(random, 8, 60), entry_z: decimal(random, .7, 2.8, 2), exit_z: decimal(random, .05, .6, 2),
  };
  if (family === "Range expansion") return { ...common, lookback: integer(random, 8, 80), buffer: decimal(random, .0001, .01, 5) };
  return {
    ...common, lookback: integer(random, 8, 60), vol_ceiling: decimal(random, .08, .9, 3), threshold: decimal(random, .0005, .03, 5),
  };
}

function scopedSymbols(random, minimum, maximum = 5) {
  const count = integer(random, minimum, Math.min(INITIAL_UNIVERSE_SYMBOLS.length, Math.max(minimum, maximum)));
  const symbols = [...INITIAL_UNIVERSE_SYMBOLS];
  // Fisher-Yates is deterministic and avoids accidentally duplicated symbols.
  for (let i = symbols.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [symbols[i], symbols[j]] = [symbols[j], symbols[i]];
  }
  return symbols.slice(0, count).sort();
}

function sampledDna(contract, seed, trialId, random, generation = 1, parentStrategyId = null, symbols = null) {
  const family = pick(random, DSL_FAMILIES);
  return buildGeneratedStrategyDNA({ family, params: sampledParams(family, random), seed, trialId, generation,
    parentStrategyId, symbols: symbols ?? scopedSymbols(random, contract.config.minimum_symbols,
      contract.config.maximum_symbols) }).dna;
}

function parentDna(candidate) {
  const dna = candidate?.dna ?? candidate?.strategy_dna ?? candidate;
  try { validateStrategyDNA(dna); return dna; } catch { return null; }
}

function normalizedParents(parents) {
  const byHash = new Map();
  for (const parent of parents ?? []) {
    const dna = parentDna(parent);
    if (dna) byHash.set(dna.dna_hash, dna);
  }
  return [...byHash.values()].sort((a, b) => a.dna_hash.localeCompare(b.dna_hash));
}

function childOf(parent, { seed, trialId }) {
  const body = clone(parent); delete body.strategy_id; delete body.dna_hash;
  body.lineage = {
    trial_id: trialId,
    generation: Math.min(1000, Number(parent.lineage.generation) + 1),
    parent_strategy_id: parent.strategy_id,
    creation_seed: seed >>> 0,
  };
  return body;
}

function numericNode(dna) {
  return dna.features.find((node) => !["greater_than", "greater_equal", "less_than", "less_equal", "equal", "and", "or", "not", "is_finite", "is_missing"].includes(node.op));
}
function booleanNode(dna) {
  return dna.features.find((node) => ["greater_than", "greater_equal", "less_than", "less_equal", "equal", "and", "or", "not", "is_finite", "is_missing"].includes(node.op));
}
function uniqueId(dna, prefix) {
  const found = new Set(dna.features.map((node) => node.id));
  for (let index = 1; index < 100; index += 1) if (!found.has(`${prefix}${index}`)) return `${prefix}${index}`;
  throw new Error("feature ID capacity exhausted");
}

function parameterPerturbation(parent, context) {
  const child = childOf(parent, context); const random = context.random;
  // Window/lag changes alter the derived warmup, so they are deliberately
  // handled by subtree replacement instead of creating stale warmup metadata.
  // Perturbing a threshold or sizing parameter stays structurally valid.
  const constants = child.features.filter((node) => node.op === "constant");
  const node = constants.length ? pick(random, constants) : null;
  if (node) node.params.value = decimal(random, -2, 2, 5);
  else child.target.position_size = decimal(random, .1, 1, 3);
  return child;
}

function featureSubstitution(parent, context) {
  const child = childOf(parent, context); const options = [["sma", "ema"], ["ema", "sma"], ["greater_than", "greater_equal"], ["greater_equal", "greater_than"], ["less_than", "less_equal"], ["less_equal", "less_than"]];
  const node = child.features.find((item) => options.some(([from]) => item.op === from));
  if (!node) throw new Error("no substitutable feature");
  node.op = options.find(([from]) => node.op === from)[1];
  return child;
}

function subtreeReplacement(parent, context) {
  // A complete sampled graph is a type-safe subtree boundary: it cannot leave
  // dangling IDs or change a boolean entry into a numeric value.
  const generated = sampledDna(context.contract, context.seed, context.trialId, context.random,
    Math.min(1000, parent.lineage.generation + 1), parent.strategy_id, parent.scope.symbols);
  const child = clone(generated); delete child.strategy_id; delete child.dna_hash;
  return child;
}

function conditionAddRemove(parent, context) {
  const child = childOf(parent, context); const random = context.random;
  if (random() < .5 && (child.entry.long || child.entry.short)) {
    const field = child.entry.short && random() < .5 ? "short" : "long";
    child.entry[field] = null;
    return child;
  }
  const source = child.entry.long ?? child.entry.short ?? booleanNode(child)?.id;
  if (!source) throw new Error("no boolean condition to add");
  const one = uniqueId(child, "gateone"); const zero = uniqueId({ ...child, features: [...child.features, { id: one }] }, "gatezero");
  const gate = uniqueId({ ...child, features: [...child.features, { id: one }, { id: zero }] }, "gate");
  const combined = uniqueId({ ...child, features: [...child.features, { id: one }, { id: zero }, { id: gate }] }, "entrygate");
  child.features.push({ id: one, op: "constant", inputs: [], params: { value: 1 } }, { id: zero, op: "constant", inputs: [], params: { value: 0 } },
    { id: gate, op: "greater_than", inputs: [one, zero], params: {} }, { id: combined, op: "and", inputs: [source, gate], params: {} });
  if (child.entry.long) child.entry.long = combined; else child.entry.short = combined;
  return child;
}

function exitMutation(parent, context) {
  const child = childOf(parent, context);
  if (child.exit.flat) { child.exit.flat = null; return child; }
  const source = numericNode(child);
  if (!source || child.features.length > 60) throw new Error("no capacity for exit condition");
  const absolute = uniqueId(child, "exitabs"); const limit = uniqueId({ ...child, features: [...child.features, { id: absolute }] }, "exitlimit");
  const flat = uniqueId({ ...child, features: [...child.features, { id: absolute }, { id: limit }] }, "exitflat");
  child.features.push({ id: absolute, op: "absolute", inputs: [source.id], params: {} }, { id: limit, op: "constant", inputs: [], params: { value: .00001 } },
    { id: flat, op: "less_than", inputs: [absolute, limit], params: {} });
  child.exit.flat = flat;
  return child;
}

function universeScopeMutation(parent, context) {
  const child = childOf(parent, context);
  child.scope.symbols = scopedSymbols(context.random, context.contract.config.minimum_symbols,
    context.contract.config.maximum_symbols);
  return child;
}

function crossover(first, second, context) {
  if (!second) throw new Error("crossover requires two valid parents");
  // Both parents are independently schema-validated. Swapping complete typed
  // sections preserves graph references, field types, and causal constraints.
  const child = childOf(first, context);
  child.scope = clone(second.scope);
  child.target = clone(second.target);
  child.risk = clone(second.risk);
  child.cooldown = clone(second.cooldown);
  return child;
}

const OPERATIONS = Object.freeze({
  parameter_perturbation: (parents, context) => parameterPerturbation(parents[0], context),
  feature_substitution: (parents, context) => featureSubstitution(parents[0], context),
  subtree_replacement: (parents, context) => subtreeReplacement(parents[0], context),
  condition_add_remove: (parents, context) => conditionAddRemove(parents[0], context),
  exit_mutation: (parents, context) => exitMutation(parents[0], context),
  universe_scope_mutation: (parents, context) => universeScopeMutation(parents[0], context),
  type_compatible_crossover: (parents, context) => crossover(parents[0], parents[1], context),
});

function proposalRecord({ contract, ordinal, seed, proposalKind, operator, parents, beforeHash, candidate, archive }) {
  const trialId = deterministicTrialId(contract.cohort_id, ordinal);
  const record = { trial_id: trialId, cohort_id: contract.cohort_id, ordinal, seed, proposal_kind: proposalKind, operator,
    parent_hashes: parents.map((parent) => parent.dna_hash).sort(), before_hash: beforeHash ?? null, after_hash: null, dna_hash: null,
    dna: null, structural_status: "invalid", rejection_reason: null };
  try {
    const dna = buildStrategyDNA(candidate);
    validateStrategyDNA(dna);
    record.after_hash = dna.dna_hash; record.dna_hash = dna.dna_hash; record.dna = dna;
    if (archive.has(dna.dna_hash)) { record.structural_status = "duplicate"; record.rejection_reason = "DNA_HASH_ALREADY_SEEN"; }
    else { record.structural_status = "valid"; archive.add(dna.dna_hash); }
  } catch (error) {
    record.rejection_reason = `STRUCTURAL_INVALID: ${String(error?.message ?? error).slice(0, 240)}`;
  }
  return record;
}

/**
 * Produce exactly the contract budget in ordinal order.  Invalid and duplicate
 * attempts deliberately stay in this registry so trial-aware evaluation can
 * account for every hypothesis, including ones that consumed no backtest.
 */
export function proposePopulation(contract, { parents = [], archiveDnaHashes = [] } = {}) {
  if (!contract?.config || !contract.cohort_id || !contract.contract_hash) throw new TypeError("A frozen research contract is required");
  const total = Number(contract.config.total_trials);
  if (!Number.isInteger(total) || total < 1) throw new TypeError("contract.config.total_trials must be positive");
  const initialCount = Number(contract.config.sampled_genomes);
  const archive = new Set((archiveDnaHashes ?? []).map(String));
  const externalParents = normalizedParents(parents).filter((dna) => dna.scope.symbols.length
    <= contract.config.maximum_symbols);
  const generatedParents = [];
  const records = [];
  for (let ordinal = 0; ordinal < total; ordinal += 1) {
    const seed = trialSeed(contract, ordinal); const random = randomStream(seed); const trialId = deterministicTrialId(contract.cohort_id, ordinal);
    if (ordinal < initialCount) {
      const candidate = sampledDna(contract, seed, trialId, random);
      const record = proposalRecord({ contract, ordinal, seed, proposalKind: "sample", operator: "grammar_sample", parents: [], candidate, archive });
      records.push(record); if (record.structural_status === "valid") generatedParents.push(record.dna);
      continue;
    }
    const challengerOrdinal = ordinal - initialCount;
    const operator = CHALLENGER_OPERATORS[challengerOrdinal % CHALLENGER_OPERATORS.length];
    const pool = [...externalParents, ...generatedParents].sort((a, b) => a.dna_hash.localeCompare(b.dna_hash));
    const first = pool.length ? pool[Math.floor(random() * pool.length)] : null;
    const second = pool.length > 1 ? pool[(pool.indexOf(first) + 1 + Math.floor(random() * (pool.length - 1))) % pool.length] : null;
    const selected = first ? (operator === "type_compatible_crossover" ? [first, second].filter(Boolean) : [first]) : [];
    let candidate = null;
    try {
      candidate = first ? OPERATIONS[operator](selected, { contract, seed, trialId, random }) : null;
      if (!candidate) throw new Error("no valid parent available for challenger");
    } catch (error) {
      records.push(proposalRecord({ contract, ordinal, seed, proposalKind: "challenger", operator, parents: selected,
        beforeHash: first?.dna_hash ?? null, candidate: { invalid: String(error?.message ?? error) }, archive }));
      continue;
    }
    const record = proposalRecord({ contract, ordinal, seed, proposalKind: "challenger", operator, parents: selected,
      beforeHash: first.dna_hash, candidate, archive });
    records.push(record); if (record.structural_status === "valid") generatedParents.push(record.dna);
  }
  return records;
}
