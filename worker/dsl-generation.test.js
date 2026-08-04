import assert from "node:assert/strict";
import test from "node:test";

import { validateStrategyDNA } from "./dsl.js";
import { DSL_FAMILIES, buildGeneratedStrategyDNA } from "./dsl-generation.js";

const params = {
  "Dual average trend": { fast: 8, slow: 30, threshold: .002, position_size: .7 },
  "Residual reversion": { lookback: 20, entry_z: 1.2, exit_z: .3, position_size: .6 },
  "Range expansion": { lookback: 24, buffer: .001, position_size: .8 },
  "Quiet trend": { lookback: 18, vol_ceiling: .3, threshold: .006, position_size: .5 },
};

test("new generator families produce complete immutable DSL-only documents", () => {
  for (const family of DSL_FAMILIES) {
    const result = buildGeneratedStrategyDNA({ family, params: params[family], seed: 41,
      trialId: `trial-${family.replaceAll(" ", "-")}`, generation: 1 });
    assert.equal(result.dna.scope.symbols.length, 40);
    assert.equal(result.dna.target.max_strategy_gross, .005);
    assert.equal(result.dna.target.normalization, "equal_weight");
    assert.equal(result.explanation.graph.nodes.length, result.dna.features.length);
    assert.doesNotThrow(() => validateStrategyDNA(result.dna));
  }
});
