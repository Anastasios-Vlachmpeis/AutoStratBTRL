"""Stable hashes and replay metadata for backtest artifacts.

This module intentionally has no FastAPI or Backtrader dependency.  The
service can construct an artifact after execution, while a separate audit
process can recompute its hashes from the immutable request and result.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping

from .metrics import METRIC_DEFINITION_VERSION


ARTIFACT_SCHEMA_VERSION = "backtest-artifact-v2"
REPLAY_METADATA_VERSION = "replay-metadata-v1"
EXECUTION_CONTRACT_VERSION = "execution-v2"


def canonical_json(value: Any) -> bytes:
    """Encode JSON deterministically, including nested mappings and arrays."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")


def sha256(value: Any) -> str:
    """Hash a JSON-compatible object using the canonical representation."""
    return hashlib.sha256(canonical_json(value)).hexdigest()


def result_hash(result: Mapping[str, Any]) -> str:
    """Hash result content after removing its self-referential hash field."""
    return sha256({key: value for key, value in result.items() if key != "result_hash"})


def build_replay_metadata(
    *,
    job_id: str | None = None,
    request_hash: str | None = None,
    input_hash: str,
    result_hash_value: str,
    dataset_hash: str,
    dna_hashes: list[str],
    compiler_hash: str,
    engine_version: str,
    configuration_hash: str,
    engine_hash: str | None = None,
    evaluation_windows: list[Mapping[str, Any]],
) -> dict[str, Any]:
    """Build portable replay instructions without embedding secrets or raw bars.

    The command is descriptive metadata, not a shell interpolation mechanism;
    hashes are passed as opaque identifiers by the deployment-specific runner.
    """
    metadata = {
        "replay_metadata_version": REPLAY_METADATA_VERSION,
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "execution_contract_version": EXECUTION_CONTRACT_VERSION,
        "metrics_schema_version": METRIC_DEFINITION_VERSION,
        "metric_definition_version": METRIC_DEFINITION_VERSION,
        "job_id": job_id or "",
        "request_hash": request_hash or input_hash,
        "input_hash": input_hash,
        "result_hash": result_hash_value,
        "dataset_hash": dataset_hash,
        "dna_hashes": sorted(dna_hashes),
        "compiler_hash": compiler_hash,
        "engine_version": engine_version,
        "engine_hash": engine_hash or "",
        "configuration_hash": configuration_hash,
        "evaluation_windows": sorted((dict(window) for window in evaluation_windows), key=lambda window: canonical_json(window)),
    }
    metadata["replay_id"] = sha256(metadata)
    metadata["command"] = "axiom-backtest replay --replay-id " + metadata["replay_id"]
    return metadata


def build_artifact(
    result: Mapping[str, Any],
    *,
    job_id: str | None = None,
    request_hash: str | None = None,
    input_hash: str,
    dataset_hash: str,
    dna_hashes: list[str],
    compiler_hash: str,
    engine_version: str,
    configuration_hash: str,
    engine_hash: str | None = None,
    evaluation_windows: list[Mapping[str, Any]],
) -> dict[str, Any]:
    """Wrap a result in a versioned, hash-addressable artifact envelope."""
    content = {key: value for key, value in result.items() if key != "result_hash"}
    stable_result_hash = result_hash(content)
    replay = build_replay_metadata(
        job_id=job_id, request_hash=request_hash, input_hash=input_hash, result_hash_value=stable_result_hash, dataset_hash=dataset_hash,
        dna_hashes=dna_hashes, compiler_hash=compiler_hash, engine_version=engine_version,
        configuration_hash=configuration_hash, engine_hash=engine_hash, evaluation_windows=evaluation_windows,
    )
    artifact = {
        "artifact_schema_version": ARTIFACT_SCHEMA_VERSION,
        "execution_contract_version": EXECUTION_CONTRACT_VERSION,
        "metrics_schema_version": METRIC_DEFINITION_VERSION,
        "metric_definition_version": METRIC_DEFINITION_VERSION,
        "input_hash": input_hash,
        "result": content,
        "result_hash": stable_result_hash,
        "replay": replay,
    }
    artifact["artifact_hash"] = sha256(artifact)
    return artifact
