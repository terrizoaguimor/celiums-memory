// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Embedding quantisation: caller-provided float vectors to Hyphae's
//! canonical signed-Q15 domain.
//!
//! Hyphae deliberately ships no embedder — vectors arrive from the
//! caller (Workers AI bge-m3 in production, any OpenAI-compatible
//! endpoint locally). This module converts those floats into
//! [`Q15Vector`]s, failing loudly on anything that would degrade
//! recall silently (wrong dimension, non-finite values, zero vectors).

use hyphae_core::{Q15Vector, VectorValueError};
use thiserror::Error;

/// Largest representable Q15 magnitude. `i16::MIN` is rejected by
/// Hyphae, so the domain is symmetric: `[-32767, 32767]`.
const Q15_SCALE: f32 = 32_767.0;

/// Failure while quantising a float embedding.
#[derive(Debug, Error)]
pub enum QuantizeError {
    /// The embedding dimension does not match the configured space.
    #[error("embedding has dimension {got}, the memory space expects {expected}")]
    DimensionMismatch {
        /// Configured dimension.
        expected: u16,
        /// Received dimension.
        got: usize,
    },
    /// The embedding contains NaN or infinity.
    #[error("embedding component {index} is not finite")]
    NotFinite {
        /// Offending component index.
        index: usize,
    },
    /// The canonical vector domain rejected the result (for example an
    /// all-zero embedding, which would match nothing meaningfully).
    #[error(transparent)]
    Vector(#[from] VectorValueError),
}

/// Quantises a normalised float embedding (components in `[-1, 1]`)
/// into the canonical Q15 domain, validating dimension first.
///
/// Components are clamped to `[-1, 1]` before scaling: embeddings from
/// real models are unit-normalised, so anything outside is noise, not
/// signal.
///
/// # Errors
///
/// Fails on dimension mismatch, non-finite components, or a vector the
/// canonical domain rejects (empty, oversized, all zero). It never
/// silently truncates or pads — degraded recall must be loud.
pub fn quantize(embedding: &[f32], expected_dimension: u16) -> Result<Q15Vector, QuantizeError> {
    if embedding.len() != usize::from(expected_dimension) {
        return Err(QuantizeError::DimensionMismatch {
            expected: expected_dimension,
            got: embedding.len(),
        });
    }
    let mut values = Vec::with_capacity(embedding.len());
    for (index, &component) in embedding.iter().enumerate() {
        if !component.is_finite() {
            return Err(QuantizeError::NotFinite { index });
        }
        let scaled = (component.clamp(-1.0, 1.0) * Q15_SCALE).round();
        // Casting is safe: the clamp above bounds `scaled` to ±32767.
        #[allow(clippy::cast_possible_truncation)]
        values.push(scaled as i16);
    }
    Ok(Q15Vector::new(values)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantizes_unit_components_to_full_scale() {
        let vector = quantize(&[1.0, -1.0, 0.5], 3).expect("valid embedding");
        assert_eq!(vector.as_slice(), &[32_767, -32_767, 16_384]);
    }

    #[test]
    fn rejects_wrong_dimension() {
        let error = quantize(&[1.0, 0.0], 3).expect_err("dimension must mismatch");
        assert!(matches!(
            error,
            QuantizeError::DimensionMismatch {
                expected: 3,
                got: 2
            }
        ));
    }

    #[test]
    fn rejects_non_finite_components() {
        let error = quantize(&[0.1, f32::NAN], 2).expect_err("NaN must fail");
        assert!(matches!(error, QuantizeError::NotFinite { index: 1 }));
    }

    #[test]
    fn rejects_zero_vectors_loudly() {
        let error = quantize(&[0.0, 0.0], 2).expect_err("zero vector must fail");
        assert!(matches!(error, QuantizeError::Vector(_)));
    }

    #[test]
    fn clamps_out_of_range_components() {
        let vector = quantize(&[2.0, -3.0], 2).expect("clamped embedding");
        assert_eq!(vector.as_slice(), &[32_767, -32_767]);
    }
}
