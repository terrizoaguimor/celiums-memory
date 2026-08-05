// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 3 end-to-end: the ethics write-gate and the circadian rhythm
//! wired into the engine's affect state.

use celiums_cognition::{CircadianEvent, Scope};
use celiums_memory_engine::{MemoryEngine, MemoryEngineError, RecallConfig, RememberRequest};

const DIMENSION: u16 = 256;
/// 1_770_000_000_000 ms ≡ 2026-02-02 02:40 UTC (deep night).
const NOW_MS: i64 = 1_770_000_000_000;
const HOUR_MS: i64 = 60 * 60 * 1000;

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open")
}

fn remember(
    engine: &mut MemoryEngine,
    content: &str,
    at_ms: i64,
) -> Result<celiums_memory_engine::Memory, MemoryEngineError> {
    engine.remember(RememberRequest {
        content: content.to_owned(),
        embedding: celiums_memory_engine::deterministic_embed(content, DIMENSION),
        tags: vec![],
        scope: Scope::Project,
        importance: None,
        now_ms: at_ms,
        context: None,
        embedding_space: None,
        idempotency_key: None,
    })
}

#[test]
fn ethics_gate_blocks_before_anything_is_stored() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let blocked = remember(&mut engine, "I am going to murder my neighbor", NOW_MS);
    assert!(matches!(
        blocked,
        Err(MemoryEngineError::EthicsBlocked {
            category,
            ..
        }) if category == "violence_harm"
    ));

    // Nothing reached the store: no memory, no entities.
    assert_eq!(engine.count().expect("count"), 0);
    assert!(engine.entities().expect("entities").is_empty());
}

#[test]
fn ethics_gate_lets_technical_kills_through() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    // The living-target disambiguation: killing processes is work.
    let stored = remember(
        &mut engine,
        "had to kill the process on port 8080 before the deploy went through",
        NOW_MS,
    );
    assert!(stored.is_ok(), "{stored:?}");
    assert_eq!(engine.count().expect("count"), 1);
}

#[test]
fn spanish_content_is_gated_too() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let blocked = remember(&mut engine, "voy a asesinar a mi jefe mañana", NOW_MS);
    assert!(matches!(
        blocked,
        Err(MemoryEngineError::EthicsBlocked { .. })
    ));

    let benign = remember(
        &mut engine,
        "hay que matar el proceso del servidor que quedó colgado",
        NOW_MS,
    );
    assert!(benign.is_ok(), "{benign:?}");
}

#[test]
fn circadian_rhythm_shapes_arousal_through_the_day() {
    let dir = tempfile::tempdir().expect("tempdir");
    let engine = open(&dir);

    // NOW_MS is ~02:40 UTC (deep night); +8h20m ≈ 11:00 (peak).
    let night = engine.affect_state(NOW_MS);
    let morning_peak = engine.affect_state(NOW_MS + 8 * HOUR_MS + 20 * 60 * 1000);
    assert!(
        morning_peak.arousal > night.arousal,
        "morning {} must beat night {}",
        morning_peak.arousal,
        night.arousal
    );
}

#[test]
fn circadian_events_move_the_rhythm() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let before = engine.affect_state(NOW_MS);
    engine
        .record_circadian_event(CircadianEvent::Caffeine { intensity: 1.0 }, NOW_MS)
        .expect("record caffeine");
    let caffeinated = engine.affect_state(NOW_MS);
    assert!(caffeinated.arousal > before.arousal, "caffeine wakes up");

    // Errors stress the engine: pleasure drops (stress penalty).
    engine
        .record_circadian_event(CircadianEvent::ErrorOccurred { intensity: 1.0 }, NOW_MS)
        .expect("record error");
    let stressed = engine.affect_state(NOW_MS);
    assert!(stressed.pleasure < caffeinated.pleasure);
}

#[test]
fn remembering_ticks_the_session_and_emotional_factors() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let before = engine.affect_state(NOW_MS);
    remember(
        &mut engine,
        "shipped the release!! amazing work, thrilled with the result!!",
        NOW_MS,
    )
    .expect("remember");
    let after = engine.affect_state(NOW_MS);

    // Session activity (+0.15 weight) and the emotional spike both
    // push arousal up relative to the pre-remember state.
    assert!(
        after.arousal > before.arousal,
        "remember must energise: {} -> {}",
        before.arousal,
        after.arousal
    );
}

#[test]
fn circadian_state_survives_reopen_with_full_continuity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caffeinated_arousal;
    {
        let mut engine = open(&dir);
        engine
            .record_circadian_event(CircadianEvent::Caffeine { intensity: 1.0 }, NOW_MS)
            .expect("caffeine");
        engine
            .record_circadian_event(CircadianEvent::ErrorOccurred { intensity: 0.8 }, NOW_MS)
            .expect("error");
        caffeinated_arousal = engine.affect_state(NOW_MS).arousal;
    }

    // Reopened engine: same rhythm, same physiology — the TS engine
    // lost all factors on every restart (process memory only).
    let engine = open(&dir);
    let reloaded = engine.affect_state(NOW_MS);
    assert!(
        (reloaded.arousal - caffeinated_arousal).abs() < 1e-9,
        "caffeine must survive the restart: {} vs {}",
        reloaded.arousal,
        caffeinated_arousal
    );

    // And it keeps decaying from where it left off: five hours later
    // half the caffeine is gone, fresh-on-read without any event.
    // (The factor is compared directly — the time-of-day rhythm also
    // moves between 02:40 and 07:40 and would mask it in arousal.)
    let now = engine.circadian_status(NOW_MS).factors.caffeine_level;
    let later = engine
        .circadian_status(NOW_MS + 5 * HOUR_MS)
        .factors
        .caffeine_level;
    assert!((now - 0.4).abs() < 1e-9, "one dose = 0.4");
    assert!((later - 0.2).abs() < 1e-9, "5h = one half-life: {later}");
}

#[test]
fn behavioural_rhythm_infers_the_user_timezone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    // Fresh engine: no signal → UTC fallback, honest provenance.
    let (offset, source) = engine.effective_timezone();
    assert_eq!((offset, source), (0, "utc-fallback"));

    // A Medellín user (UTC-5) interacting daily 09:00-21:00 local
    // (14:00-02:00 UTC) for two weeks.
    let mut at_ms = NOW_MS;
    for _day in 0..14 {
        for local_hour in [9, 11, 13, 15, 17, 19, 21] {
            let utc_hour = (local_hour + 5) % 24;
            let event_ms = at_ms + i64::from(utc_hour) * HOUR_MS;
            engine
                .record_circadian_event(CircadianEvent::SessionActive, event_ms)
                .expect("session");
        }
        at_ms += 24 * HOUR_MS;
    }

    let (offset, source) = engine.effective_timezone();
    assert_eq!(source, "behavior", "two weeks of rhythm is enough");
    assert!(
        (offset - -300).abs() <= 60,
        "inferred {offset} min, want ≈ -300 (UTC-5)"
    );

    // The status endpoint reports the same picture.
    let status = engine.circadian_status(NOW_MS + 20 * HOUR_MS);
    assert_eq!(status.source, "behavior");
    assert!(status.rhythm.confidence >= 0.3);

    // An explicit override always wins over behaviour.
    let mut engine = engine;
    engine
        .set_timezone_override(Some(120), NOW_MS + 15 * 24 * HOUR_MS)
        .expect("override");
    let (offset, source) = engine.effective_timezone();
    assert_eq!((offset, source), (120, "override"));

    // And the override survives reopen too.
    drop(engine);
    let engine = open(&dir);
    let (offset, source) = engine.effective_timezone();
    assert_eq!((offset, source), (120, "override"));
}

#[test]
fn local_hour_drives_the_rhythm_not_utc() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    // NOW_MS ≈ 02:40 UTC. For a UTC user that is deep night; with a
    // UTC+9 override it is 11:40 local — right at the morning peak.
    let utc_night = engine.affect_state(NOW_MS).arousal;
    engine
        .set_timezone_override(Some(9 * 60), NOW_MS)
        .expect("override");
    let tokyo_morning = engine.affect_state(NOW_MS).arousal;
    assert!(
        tokyo_morning > utc_night,
        "the SAME instant must feel different in Tokyo: {utc_night} vs {tokyo_morning}"
    );

    let status = engine.circadian_status(NOW_MS);
    assert_eq!(status.time_of_day, "morning-peak");
}
