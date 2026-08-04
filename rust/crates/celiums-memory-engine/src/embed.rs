// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Deterministic offline embedder: word/bigram hashing with TF-like
//! weighting and L2 normalisation.
//!
//! Port of `store.ts` `deterministicEmbed` (the fallback that keeps the
//! TS engine alive when the embedding endpoint is down). Here it is a
//! first-class default instead of a fallback: the engine must work
//! offline with zero providers, and callers with a real model (bge-m3
//! in production) simply pass their own vectors.
//!
//! Not semantically deep — it is lexical — but deterministic, instant,
//! dependency-free, and similar texts produce similar vectors.

use std::sync::LazyLock;

/// Stopwords excluded from hashing (store.ts:854-860).
static STOPWORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    vec![
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
        "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
        "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
        "during", "before", "after", "and", "but", "or", "not", "no", "so", "if", "then", "than",
        "that", "this", "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "she",
        "they", "them", "his", "her", "their",
    ]
});

/// Embeds `text` into a deterministic unit vector of `dimension`
/// components (store.ts:850-886).
///
/// Each content word scatters weight over six hash-derived indices;
/// consecutive-word bigrams add half weight to one more. The result is
/// L2-normalised; an all-stopword or empty text yields the zero vector
/// (which the quantiser rejects loudly — nothing meaningful to match).
pub fn deterministic_embed(text: &str, dimension: u16) -> Vec<f32> {
    let dim = usize::from(dimension).max(1);
    let mut vector = vec![0.0f32; dim];
    let normalized = text.to_lowercase();
    let words: Vec<&str> = normalized
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() > 1 && !STOPWORDS.contains(word))
        .collect();

    let weight = 1.0 / words.len().max(1) as f32;
    for word in &words {
        let (h1, h2, h3) = triple_hash(word);
        for index in [
            h1 % dim,
            h2 % dim,
            h3 % dim,
            (h1 ^ h2) % dim,
            (h2 ^ h3) % dim,
            (h1 ^ h3) % dim,
        ] {
            vector[index] += weight;
        }
    }

    for pair in words.windows(2) {
        let bigram = format!("{}_{}", pair[0], pair[1]);
        let (h1, _, _) = triple_hash(&bigram);
        vector[h1 % dim] += 0.5 * weight;
    }

    let magnitude = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if magnitude > 0.0 {
        for component in &mut vector {
            *component /= magnitude;
        }
    }
    vector
}

/// The three rolling hashes of store.ts:863-869, on i32 wrapping
/// arithmetic exactly like JS `| 0`, mapped to non-negative indices.
fn triple_hash(word: &str) -> (usize, usize, usize) {
    let mut h1: i32 = 0;
    let mut h2: i32 = 0;
    let mut h3: i32 = 0;
    for unit in word.encode_utf16() {
        let c = i32::from(unit);
        h1 = (h1 << 5).wrapping_sub(h1).wrapping_add(c);
        h2 = h2.wrapping_mul(31).wrapping_add(c);
        h3 = (h3 ^ c).wrapping_mul(16_777_619);
    }
    (
        h1.unsigned_abs() as usize,
        h2.unsigned_abs() as usize,
        h3.unsigned_abs() as usize,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIM: u16 = 256;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn embedding_is_deterministic_and_unit_length() {
        let first = deterministic_embed("Rust ownership prevents data races", DIM);
        let second = deterministic_embed("Rust ownership prevents data races", DIM);
        assert_eq!(first, second);
        let norm: f32 = first.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    #[test]
    fn similar_texts_score_higher_than_unrelated_ones() {
        let query = deterministic_embed("deploy the rust engine to production", DIM);
        let related = deterministic_embed("production deploy of the rust engine", DIM);
        let unrelated = deterministic_embed("the coffee machine is broken again", DIM);
        assert!(cosine(&query, &related) > cosine(&query, &unrelated));
        assert!(cosine(&query, &related) > 0.5);
    }

    #[test]
    fn stopword_only_text_yields_zero_vector() {
        let vector = deterministic_embed("the a an is to of", DIM);
        assert!(vector.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn empty_text_yields_zero_vector() {
        assert!(deterministic_embed("", DIM).iter().all(|v| *v == 0.0));
    }
}
