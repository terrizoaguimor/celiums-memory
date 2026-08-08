// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Versioned logical portability and recovery primitives.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use getrandom::fill as random_fill;
use hyphae_core::{Q15Vector, VectorSpaceDefinition, VectorSpaceName};
use hyphae_engine::HyphaeEngine;
use hyphae_query::{FieldPath, Record, Value, decode_document};
use hyphae_retrieval::{LexicalField, LexicalIndexDefinition};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{TenantId, embedding_space::EmbeddingSpaceIdentity};

const FORMAT: &str = "celiums-memory-logical";
const FORMAT_VERSION: u16 = 1;
const RECORDS_FILE: &str = "records.ndjson";
const VECTORS_FILE: &str = "vectors.ndjson";
const BACKUP_FILE: &str = "backup.bin";
const ENVELOPE_FILE: &str = "ENVELOPE.json";
const CHECKPOINT_MAGIC: &[u8] = b"CELIUMSCP";
const CHECKPOINT_VERSION: u16 = 1;
const MAX_CHECKPOINT_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MEMORY_SPACE: &str = "memories";
const CONTENT_INDEX: &str = "content";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;

/// Scope selected by a logical export or erasure operation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExportSelector {
    /// Every logical record physically owned by one tenant.
    Tenant {
        /// Physical tenant identifier.
        tenant_id: String,
    },
    /// Records owned by one user. Tenant-global records are omitted.
    User {
        /// Physical tenant identifier.
        tenant_id: String,
        /// Logical user identifier.
        user_id: String,
    },
    /// Records directly owned by one project.
    Project {
        /// Physical tenant identifier.
        tenant_id: String,
        /// Logical user identifier.
        user_id: String,
        /// Project identifier.
        project_id: String,
    },
}

impl ExportSelector {
    pub(crate) fn tenant_id(&self) -> &str {
        match self {
            Self::Tenant { tenant_id }
            | Self::User { tenant_id, .. }
            | Self::Project { tenant_id, .. } => tenant_id,
        }
    }
}

/// Stable logical export manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LogicalManifest {
    /// Format discriminator.
    pub format: String,
    /// Format version.
    pub format_version: u16,
    /// Selection applied to the export.
    pub selector: ExportSelector,
    /// Source checkpoint sequence.
    pub checkpoint_sequence: u64,
    /// Source snapshot digest in lowercase hex.
    pub snapshot_digest: String,
    /// Number of exported records.
    pub record_count: u64,
    /// Number of exported vectors.
    pub vector_count: u64,
    /// BLAKE3 digest of records.ndjson.
    pub records_blake3: String,
    /// BLAKE3 digest of vectors.ndjson.
    pub vectors_blake3: String,
    /// BLAKE3 root over the file descriptors.
    pub root_blake3: String,
}

/// Export result and its verified manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogicalExportInfo {
    /// Destination directory.
    pub path: PathBuf,
    /// Verified manifest.
    pub manifest: LogicalManifest,
}

/// Report returned after a destination restore.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestoreReport {
    /// Activated destination path.
    pub data_path: PathBuf,
    /// Restored record count.
    pub record_count: u64,
    /// Restored vector count.
    pub vector_count: u64,
}

/// Mechanical residue result for a selector.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResidueReport {
    /// Selector checked.
    pub selector: ExportSelector,
    /// Whether no matching records remained.
    pub clean: bool,
    /// Matching record keys, encoded as lowercase hex.
    pub matching_keys: Vec<String>,
}

/// Result returned by a hard-delete operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HardDeleteReport {
    /// Selector erased.
    pub selector: ExportSelector,
    /// Number of logical records removed from the active store.
    pub removed_records: u64,
    /// Residue check after the operation.
    pub residue: ResidueReport,
}

/// Retention policy for encrypted backup directories.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackupRetentionPolicy {
    /// Keep at least this many newest backups.
    pub keep_last: usize,
    /// Delete backups older than this age.
    pub max_age_ms: i64,
}

/// Encrypted backup metadata.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct EncryptedBackupInfo {
    /// Backup directory.
    pub path: PathBuf,
    /// Creation timestamp.
    pub created_at_ms: i64,
    /// Ciphertext BLAKE3 digest.
    pub ciphertext_blake3: String,
    /// Hyphae checkpoint sequence included in the backup.
    pub checkpoint_sequence: u64,
    /// Verified Hyphae snapshot digest in lowercase hex.
    pub snapshot_digest: String,
    /// Ciphertext byte count.
    pub ciphertext_bytes: u64,
    /// Decrypted payload byte count.
    pub plaintext_bytes: u64,
}

/// Public metadata for a binary Cloudflare checkpoint artifact.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CheckpointArtifactInfo {
    /// Wire format version.
    pub format_version: u16,
    /// Hyphae checkpoint sequence included in the artifact.
    pub checkpoint_sequence: u64,
    /// Verified Hyphae snapshot digest in lowercase hex.
    pub snapshot_digest: String,
    /// BLAKE3 digest of the encrypted payload.
    pub ciphertext_blake3: String,
    /// Encrypted payload byte count.
    pub ciphertext_bytes: u64,
    /// Decrypted payload byte count.
    pub plaintext_bytes: u64,
}

/// Migration kind supported by the plan contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum MigrationKind {
    /// External TypeScript export into Rust logical format.
    TypescriptToRust,
    /// Rebuild the same records in a new embedding space.
    EmbeddingSpace,
}

/// Read-only migration plan.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MigrationPlan {
    /// Migration type.
    pub kind: MigrationKind,
    /// Source directory digest.
    pub source_blake3: String,
    /// Destination that apply would create.
    pub destination: PathBuf,
    /// Number of source bytes observed.
    pub source_bytes: u64,
    /// Plan digest.
    pub plan_blake3: String,
}

/// Portability failures are intentionally stable at the boundary.
#[derive(Debug, Error)]
pub enum PortabilityError {
    /// Filesystem operation failed.
    #[error("portability filesystem error: {0}")]
    Io(#[from] std::io::Error),
    /// Serialization or manifest decoding failed.
    #[error("portability manifest error: {0}")]
    Manifest(String),
    /// Format version is not supported.
    #[error("unsupported logical export format version")]
    UnsupportedVersion,
    /// Integrity digest mismatch.
    #[error("logical export integrity check failed")]
    Integrity,
    /// Tenant or ownership mismatch.
    #[error("logical export ownership check failed")]
    Ownership,
    /// Destination already exists.
    #[error("import destination must not already exist")]
    DestinationExists,
    /// A duplicate key was found.
    #[error("logical export contains a duplicate key")]
    DuplicateKey,
    /// A record or vector could not be decoded.
    #[error("logical export record is malformed")]
    MalformedRecord,
    /// Cryptographic envelope operation failed.
    #[error("encrypted backup operation failed")]
    Crypto,
    /// A migration source changed after planning.
    #[error("migration source changed after dry-run")]
    SourceChanged,
    /// A migration plan is malformed or does not match the requested operation.
    #[error("migration plan is invalid")]
    InvalidPlan,
}

#[derive(Serialize, Deserialize)]
struct RecordLine {
    key_hex: String,
    value_hex: String,
}

#[derive(Serialize, Deserialize)]
struct VectorLine {
    space: String,
    key_hex: String,
    q15: Vec<i16>,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u16,
    created_at_ms: i64,
    checkpoint_sequence: u64,
    snapshot_digest: String,
    nonce_hex: String,
    ciphertext_blake3: String,
    plaintext_bytes: u64,
}

#[derive(Deserialize)]
struct BackupMetadata {
    checkpoint_sequence: u64,
    snapshot_digest: String,
}

/// Creates a deterministic logical export from a verified Hyphae snapshot.
pub(crate) fn export_snapshot(
    snapshot_path: &Path,
    output: &Path,
    selector: ExportSelector,
) -> Result<LogicalExportInfo, PortabilityError> {
    if output.exists() {
        return Err(PortabilityError::DestinationExists);
    }
    let snapshot = hyphae_storage::load_snapshot(
        snapshot_path,
        &hyphae_storage::SnapshotReadLimits::default(),
    )
    .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    fs::create_dir_all(output)?;
    let records_path = output.join(RECORDS_FILE);
    let vectors_path = output.join(VECTORS_FILE);
    let mut records = File::create(&records_path)?;
    let mut selected_keys = BTreeSet::new();
    let mut record_count = 0_u64;
    let tenant = selector.tenant_id().to_owned();
    for entry in snapshot.entries {
        if !record_matches(&entry.value, &selector, &tenant)? {
            continue;
        }
        let line = RecordLine {
            key_hex: hex(&entry.key),
            value_hex: hex(&entry.value),
        };
        let encoded = serde_json::to_vec(&line)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
        records.write_all(&encoded)?;
        records.write_all(b"\n")?;
        selected_keys.insert(entry.key);
        record_count = record_count.saturating_add(1);
    }
    records.sync_all()?;
    let mut vectors = File::create(&vectors_path)?;
    let mut vector_count = 0_u64;
    for vector in snapshot.vectors {
        if vector.space.as_str() != MEMORY_SPACE || !selected_keys.contains(&vector.key) {
            continue;
        }
        let line = VectorLine {
            space: vector.space.to_string(),
            key_hex: hex(&vector.key),
            q15: vector.vector.as_slice().to_vec(),
        };
        serde_json::to_writer(&mut vectors, &line)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
        vectors.write_all(b"\n")?;
        vector_count = vector_count.saturating_add(1);
    }
    vectors.sync_all()?;
    let manifest = build_manifest(
        selector,
        snapshot.info.checkpoint_sequence,
        hex(&snapshot.info.snapshot_digest),
        record_count,
        vector_count,
        &records_path,
        &vectors_path,
    )?;
    write_manifest(output, &manifest)?;
    Ok(LogicalExportInfo {
        path: output.to_owned(),
        manifest,
    })
}

/// Verifies an export without opening or mutating a data directory.
pub fn verify_logical_export(path: impl AsRef<Path>) -> Result<LogicalManifest, PortabilityError> {
    let path = path.as_ref();
    let manifest = read_manifest(path)?;
    verify_file(path, RECORDS_FILE, &manifest.records_blake3)?;
    verify_file(path, VECTORS_FILE, &manifest.vectors_blake3)?;
    let expected_root = root_digest(&manifest.records_blake3, &manifest.vectors_blake3);
    if expected_root != manifest.root_blake3 {
        return Err(PortabilityError::Integrity);
    }
    Ok(manifest)
}

/// Imports a logical export into a new, empty Hyphae directory.
pub fn import_logical(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<RestoreReport, PortabilityError> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    let manifest = verify_logical_export(source)?;
    if destination.exists() {
        return Err(PortabilityError::DestinationExists);
    }
    let tenant = TenantId::new(manifest.selector.tenant_id().to_owned())
        .map_err(|_| PortabilityError::Ownership)?;
    let staging = destination.with_extension(format!("staging-{}", Uuid::now_v7()));
    fs::create_dir_all(&staging)?;
    let result = import_into_staging(source, &staging, &manifest);
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    let (record_count, vector_count) = result?;
    let _ = tenant;
    fs::rename(&staging, destination)?;
    Ok(RestoreReport {
        data_path: destination.to_owned(),
        record_count,
        vector_count,
    })
}

/// Creates an encrypted Hyphae backup using a 32-byte recipient key.
pub fn create_encrypted_backup(
    engine: &HyphaeEngine,
    output: impl AsRef<Path>,
    key: &[u8; 32],
) -> Result<EncryptedBackupInfo, PortabilityError> {
    let output = output.as_ref();
    if output.exists() {
        return Err(PortabilityError::DestinationExists);
    }
    let staging_root = output
        .parent()
        .ok_or_else(|| PortabilityError::Manifest("backup output has no parent".to_owned()))?;
    fs::create_dir_all(staging_root)?;
    let staging = staging_root.join(format!("backup-staging-{}", Uuid::now_v7()));
    let backup = engine
        .backup(&staging)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let mut plaintext = Vec::new();
    let manifest = fs::read(staging.join("BACKUP.json"))?;
    let backup_metadata: BackupMetadata = serde_json::from_slice(&manifest)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let snapshot = fs::read(staging.join("snapshot.hysnap"))?;
    write_blob(&mut plaintext, &manifest)?;
    write_blob(&mut plaintext, &snapshot)?;
    let mut nonce_bytes = [0_u8; 12];
    random_fill(&mut nonce_bytes).map_err(|_| PortabilityError::Crypto)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_slice())
        .map_err(|_| PortabilityError::Crypto)?;
    fs::create_dir_all(output)?;
    fs::write(output.join(BACKUP_FILE), &ciphertext)?;
    let info = EncryptedBackupInfo {
        path: output.to_owned(),
        created_at_ms: now_ms(),
        ciphertext_blake3: blake3::hash(&ciphertext).to_hex().to_string(),
        checkpoint_sequence: backup_metadata.checkpoint_sequence,
        snapshot_digest: backup_metadata.snapshot_digest,
        ciphertext_bytes: ciphertext.len() as u64,
        plaintext_bytes: plaintext.len() as u64,
    };
    let envelope = Envelope {
        format: "celiums-memory-encrypted-backup".to_owned(),
        version: 1,
        created_at_ms: info.created_at_ms,
        checkpoint_sequence: info.checkpoint_sequence,
        snapshot_digest: info.snapshot_digest.clone(),
        nonce_hex: hex(&nonce_bytes),
        ciphertext_blake3: info.ciphertext_blake3.clone(),
        plaintext_bytes: plaintext.len() as u64,
    };
    fs::write(
        output.join(ENVELOPE_FILE),
        serde_json::to_vec_pretty(&envelope)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?,
    )?;
    fs::remove_dir_all(staging)?;
    let _ = backup;
    Ok(info)
}

/// Packs an encrypted backup directory into one versioned binary artifact.
pub fn read_encrypted_backup_artifact(
    backup: impl AsRef<Path>,
) -> Result<(CheckpointArtifactInfo, Vec<u8>), PortabilityError> {
    let backup = backup.as_ref();
    let envelope: Envelope = serde_json::from_slice(&fs::read(backup.join(ENVELOPE_FILE))?)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    validate_envelope(&envelope)?;
    let ciphertext = fs::read(backup.join(BACKUP_FILE))?;
    verify_ciphertext(&envelope, &ciphertext)?;
    let info = CheckpointArtifactInfo {
        format_version: CHECKPOINT_VERSION,
        checkpoint_sequence: envelope.checkpoint_sequence,
        snapshot_digest: envelope.snapshot_digest.clone(),
        ciphertext_blake3: envelope.ciphertext_blake3.clone(),
        ciphertext_bytes: ciphertext.len() as u64,
        plaintext_bytes: envelope.plaintext_bytes,
    };
    let envelope_bytes = serde_json::to_vec(&envelope)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let artifact = encode_checkpoint_artifact(&envelope_bytes, &ciphertext)?;
    Ok((info, artifact))
}

/// Restores one binary checkpoint artifact into a new Hyphae directory.
pub fn restore_encrypted_backup_artifact(
    artifact: &[u8],
    destination: impl AsRef<Path>,
    key: &[u8; 32],
) -> Result<RestoreReport, PortabilityError> {
    let (envelope_bytes, ciphertext) = decode_checkpoint_artifact(artifact)?;
    let envelope: Envelope = serde_json::from_slice(&envelope_bytes)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    validate_envelope(&envelope)?;
    verify_ciphertext(&envelope, &ciphertext)?;
    let staging_root = destination.as_ref().parent().ok_or_else(|| {
        PortabilityError::Manifest("restore destination has no parent".to_owned())
    })?;
    let staging = staging_root.join(format!("checkpoint-restore-{}", Uuid::now_v7()));
    fs::create_dir_all(&staging)?;
    let nonce = unhex(&envelope.nonce_hex)?;
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| PortabilityError::Crypto)?;
    let (manifest, snapshot) = split_blobs(&plaintext)?;
    fs::write(
        staging.join(ENVELOPE_FILE),
        serde_json::to_vec(&envelope)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?,
    )?;
    fs::write(staging.join(BACKUP_FILE), ciphertext)?;
    fs::write(staging.join("BACKUP.json"), manifest)?;
    fs::write(staging.join("snapshot.hysnap"), snapshot)?;
    let result = restore_encrypted_backup(&staging, destination, key);
    let _ = fs::remove_dir_all(staging);
    result
}

/// Decrypts, verifies, and restores an encrypted Hyphae backup to a new path.
#[allow(dead_code)]
pub fn restore_encrypted_backup(
    backup: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    key: &[u8; 32],
) -> Result<RestoreReport, PortabilityError> {
    let backup = backup.as_ref();
    let destination = destination.as_ref();
    if destination.exists() {
        return Err(PortabilityError::DestinationExists);
    }
    let envelope: Envelope = serde_json::from_slice(&fs::read(backup.join(ENVELOPE_FILE))?)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    validate_envelope(&envelope)?;
    let ciphertext = fs::read(backup.join(BACKUP_FILE))?;
    verify_ciphertext(&envelope, &ciphertext)?;
    let nonce = unhex(&envelope.nonce_hex)?;
    if nonce.len() != 12 {
        return Err(PortabilityError::Crypto);
    }
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice())
        .map_err(|_| PortabilityError::Crypto)?;
    if plaintext.len() as u64 != envelope.plaintext_bytes {
        return Err(PortabilityError::Integrity);
    }
    let (manifest, snapshot) = split_blobs(&plaintext)?;
    let staging = destination.with_extension(format!("restore-staging-{}", Uuid::now_v7()));
    fs::create_dir_all(&staging)?;
    fs::write(staging.join("BACKUP.json"), manifest)?;
    fs::write(staging.join("snapshot.hysnap"), snapshot)?;
    let result = HyphaeEngine::restore_backup(&staging, destination)
        .map_err(|error| PortabilityError::Manifest(error.to_string()));
    let _ = fs::remove_dir_all(&staging);
    let restored = result?;
    Ok(RestoreReport {
        data_path: restored.data_path,
        record_count: restored.snapshot.entry_count,
        vector_count: restored.snapshot.vector_count,
    })
}

fn validate_envelope(envelope: &Envelope) -> Result<(), PortabilityError> {
    if envelope.format != "celiums-memory-encrypted-backup" || envelope.version != 1 {
        return Err(PortabilityError::UnsupportedVersion);
    }
    let nonce = unhex(&envelope.nonce_hex)?;
    if nonce.len() != 12 || envelope.plaintext_bytes > MAX_CHECKPOINT_ARTIFACT_BYTES {
        return Err(PortabilityError::Crypto);
    }
    Ok(())
}

fn verify_ciphertext(envelope: &Envelope, ciphertext: &[u8]) -> Result<(), PortabilityError> {
    if ciphertext.len() as u64 > MAX_CHECKPOINT_ARTIFACT_BYTES
        || blake3::hash(ciphertext).to_hex().to_string() != envelope.ciphertext_blake3
    {
        return Err(PortabilityError::Integrity);
    }
    Ok(())
}

fn encode_checkpoint_artifact(
    envelope: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, PortabilityError> {
    if envelope.len() as u64 > MAX_MANIFEST_BYTES
        || ciphertext.len() as u64 > MAX_CHECKPOINT_ARTIFACT_BYTES
    {
        return Err(PortabilityError::Manifest(
            "checkpoint artifact is too large".to_owned(),
        ));
    }
    let mut artifact =
        Vec::with_capacity(CHECKPOINT_MAGIC.len() + 2 + 4 + 8 + envelope.len() + ciphertext.len());
    artifact.extend_from_slice(CHECKPOINT_MAGIC);
    artifact.extend_from_slice(&CHECKPOINT_VERSION.to_le_bytes());
    artifact.extend_from_slice(&(envelope.len() as u32).to_le_bytes());
    artifact.extend_from_slice(&(ciphertext.len() as u64).to_le_bytes());
    artifact.extend_from_slice(envelope);
    artifact.extend_from_slice(ciphertext);
    Ok(artifact)
}

fn decode_checkpoint_artifact(artifact: &[u8]) -> Result<(Vec<u8>, Vec<u8>), PortabilityError> {
    let header_bytes = CHECKPOINT_MAGIC.len() + 2 + 4 + 8;
    if artifact.len() < header_bytes || artifact.len() as u64 > MAX_CHECKPOINT_ARTIFACT_BYTES {
        return Err(PortabilityError::Integrity);
    }
    if &artifact[..CHECKPOINT_MAGIC.len()] != CHECKPOINT_MAGIC {
        return Err(PortabilityError::Manifest(
            "invalid checkpoint artifact".to_owned(),
        ));
    }
    let version_offset = CHECKPOINT_MAGIC.len();
    let version = u16::from_le_bytes(
        artifact[version_offset..version_offset + 2]
            .try_into()
            .map_err(|_| PortabilityError::Integrity)?,
    );
    if version != CHECKPOINT_VERSION {
        return Err(PortabilityError::UnsupportedVersion);
    }
    let envelope_offset = version_offset + 2;
    let envelope_len = u32::from_le_bytes(
        artifact[envelope_offset..envelope_offset + 4]
            .try_into()
            .map_err(|_| PortabilityError::Integrity)?,
    ) as usize;
    let ciphertext_offset = envelope_offset + 4;
    let ciphertext_len = u64::from_le_bytes(
        artifact[ciphertext_offset..ciphertext_offset + 8]
            .try_into()
            .map_err(|_| PortabilityError::Integrity)?,
    ) as usize;
    let payload_offset = header_bytes;
    let expected_len = payload_offset
        .checked_add(envelope_len)
        .and_then(|length| length.checked_add(ciphertext_len))
        .ok_or(PortabilityError::Integrity)?;
    if expected_len != artifact.len() || envelope_len as u64 > MAX_MANIFEST_BYTES {
        return Err(PortabilityError::Integrity);
    }
    Ok((
        artifact[payload_offset..payload_offset + envelope_len].to_vec(),
        artifact[payload_offset + envelope_len..].to_vec(),
    ))
}

/// Removes expired encrypted backups while preserving the newest `keep_last`.
#[allow(dead_code)]
pub fn prune_encrypted_backups(
    root: impl AsRef<Path>,
    policy: &BackupRetentionPolicy,
    now_ms: i64,
) -> Result<usize, PortabilityError> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let envelope_path = entry.path().join(ENVELOPE_FILE);
        let Ok(bytes) = fs::read(envelope_path) else {
            continue;
        };
        let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
            continue;
        };
        candidates.push((envelope.created_at_ms, entry.path()));
    }
    candidates.sort_by_key(|right| std::cmp::Reverse(right.0));
    let mut removed = 0;
    for (index, (created_at_ms, path)) in candidates.into_iter().enumerate() {
        if index < policy.keep_last || now_ms.saturating_sub(created_at_ms) <= policy.max_age_ms {
            continue;
        }
        fs::remove_dir_all(path)?;
        removed += 1;
    }
    Ok(removed)
}

/// Computes a migration plan without writing the destination.
#[allow(dead_code)]
pub fn plan_migration(
    kind: MigrationKind,
    source: impl AsRef<Path>,
    destination: impl Into<PathBuf>,
) -> Result<MigrationPlan, PortabilityError> {
    let source = source.as_ref();
    let source_blake3 = directory_digest(source)?;
    let source_bytes = directory_bytes(source)?;
    let destination = destination.into();
    let mut plan = MigrationPlan {
        kind,
        source_blake3,
        destination,
        source_bytes,
        plan_blake3: String::new(),
    };
    plan.plan_blake3 = plan_digest(&plan)?;
    Ok(plan)
}

/// Applies a frozen migration plan using copy-on-write import.
#[allow(dead_code)]
pub fn apply_migration(
    plan: &MigrationPlan,
    source: impl AsRef<Path>,
) -> Result<RestoreReport, PortabilityError> {
    if plan.plan_blake3 != plan_digest(plan)?
        || plan.source_blake3 != directory_digest(source.as_ref())?
    {
        return Err(PortabilityError::SourceChanged);
    }
    import_logical(source, &plan.destination)
}

/// Reports active records that match a selector.
#[allow(dead_code)]
pub fn residue_report(
    data_path: impl AsRef<Path>,
    selector: ExportSelector,
) -> Result<ResidueReport, PortabilityError> {
    let opened = HyphaeEngine::open(data_path)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let snapshot = opened
        .engine
        .snapshot()
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let snapshot = hyphae_storage::load_snapshot(
        &snapshot.path,
        &hyphae_storage::SnapshotReadLimits::default(),
    )
    .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    let tenant = selector.tenant_id().to_owned();
    let mut matching_keys = Vec::new();
    for entry in snapshot.entries {
        if record_matches(&entry.value, &selector, &tenant)? {
            matching_keys.push(hex(&entry.key));
        }
    }
    Ok(ResidueReport {
        selector,
        clean: matching_keys.is_empty(),
        matching_keys,
    })
}

/// Deletes a tenant physically or rebuilds a selective survivor store.
#[allow(dead_code)]
pub fn hard_delete_store(
    data_path: impl AsRef<Path>,
    selector: ExportSelector,
) -> Result<HardDeleteReport, PortabilityError> {
    let source = data_path.as_ref().to_owned();
    let before = residue_report(&source, selector.clone())?;
    let removed_records = before.matching_keys.len() as u64;
    if matches!(selector, ExportSelector::Tenant { .. }) {
        fs::remove_dir_all(&source)?;
        return Ok(HardDeleteReport {
            selector,
            removed_records,
            residue: ResidueReport {
                selector: ExportSelector::Tenant {
                    tenant_id: before.selector.tenant_id().to_owned(),
                },
                clean: true,
                matching_keys: Vec::new(),
            },
        });
    }
    let parent = source
        .parent()
        .ok_or_else(|| PortabilityError::Manifest("store has no parent".to_owned()))?;
    let export_dir = parent.join(format!("delete-export-{}", Uuid::now_v7()));
    let survivor_dir = parent.join(format!("delete-survivors-{}", Uuid::now_v7()));
    {
        let opened = HyphaeEngine::open(&source)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
        let snapshot = opened
            .engine
            .snapshot()
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
        export_snapshot(
            &snapshot.path,
            &export_dir,
            ExportSelector::Tenant {
                tenant_id: selector.tenant_id().to_owned(),
            },
        )?;
    }
    filter_export(&export_dir, &survivor_dir, &selector)?;
    let restored = survivor_dir.with_extension("restored");
    import_logical(&survivor_dir, &restored)?;
    fs::remove_dir_all(&source)?;
    fs::rename(&restored, &source)?;
    fs::remove_dir_all(&export_dir)?;
    fs::remove_dir_all(&survivor_dir)?;
    let residue = residue_report(&source, selector.clone())?;
    Ok(HardDeleteReport {
        selector,
        removed_records,
        residue,
    })
}

fn import_into_staging(
    source: &Path,
    staging: &Path,
    manifest: &LogicalManifest,
) -> Result<(u64, u64), PortabilityError> {
    let mut records = Vec::new();
    let mut seen = BTreeSet::new();
    for line in BufReader::new(File::open(source.join(RECORDS_FILE))?).lines() {
        let line = line?;
        if line.len() as u64 > MAX_RECORD_BYTES {
            return Err(PortabilityError::MalformedRecord);
        }
        let record: RecordLine =
            serde_json::from_str(&line).map_err(|_| PortabilityError::MalformedRecord)?;
        let key = unhex(&record.key_hex)?;
        if !seen.insert(key.clone()) {
            return Err(PortabilityError::DuplicateKey);
        }
        let value = unhex(&record.value_hex)?;
        let _ = decode_document(&value).map_err(|_| PortabilityError::MalformedRecord)?;
        records.push(Record::new(
            key,
            decode_document(&value).map_err(|_| PortabilityError::MalformedRecord)?,
        ));
    }
    let embedding_space = records
        .iter()
        .find(|record| record.key.as_slice() == b"__celiums/embedding_space")
        .map(EmbeddingSpaceIdentity::from_record)
        .transpose()
        .map_err(|_| PortabilityError::MalformedRecord)?
        .ok_or(PortabilityError::MalformedRecord)?;
    let tenant = TenantId::new(manifest.selector.tenant_id().to_owned())
        .map_err(|_| PortabilityError::Ownership)?;
    for record in &records {
        if !record_matches(
            &encode_value(&record.value)?,
            &ExportSelector::Tenant {
                tenant_id: tenant.to_string(),
            },
            tenant.as_str(),
        )? {
            return Err(PortabilityError::Ownership);
        }
    }
    let mut vectors = Vec::new();
    for line in BufReader::new(File::open(source.join(VECTORS_FILE))?).lines() {
        let line = line?;
        let vector: VectorLine =
            serde_json::from_str(&line).map_err(|_| PortabilityError::MalformedRecord)?;
        let name =
            VectorSpaceName::new(vector.space).map_err(|_| PortabilityError::MalformedRecord)?;
        let value = Q15Vector::new(vector.q15).map_err(|_| PortabilityError::MalformedRecord)?;
        vectors.push((name, unhex(&vector.key_hex)?, value));
    }
    let mut opened = HyphaeEngine::open(staging)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    opened
        .engine
        .define_vector_space(
            Uuid::now_v7(),
            VectorSpaceDefinition::cosine(
                VectorSpaceName::new(MEMORY_SPACE).unwrap(),
                embedding_space.dimension,
            )
            .map_err(|_| PortabilityError::MalformedRecord)?,
        )
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    opened
        .engine
        .define_lexical_index(
            Uuid::now_v7(),
            LexicalIndexDefinition::new(
                VectorSpaceName::new(CONTENT_INDEX).unwrap(),
                vec![LexicalField {
                    path: FieldPath::field("content"),
                    weight_micros: 1_000_000,
                }],
            )
            .map_err(|_| PortabilityError::MalformedRecord)?,
        )
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    if !records.is_empty() {
        opened
            .engine
            .put_records(Uuid::now_v7(), &records)
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    }
    if !vectors.is_empty() {
        let values = vectors
            .iter()
            .map(|(_, key, vector)| (key.clone(), vector.clone()))
            .collect::<Vec<_>>();
        opened
            .engine
            .put_vectors(
                Uuid::now_v7(),
                &VectorSpaceName::new(MEMORY_SPACE).unwrap(),
                &values,
            )
            .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    }
    if records.len() as u64 != manifest.record_count
        || vectors.len() as u64 != manifest.vector_count
    {
        return Err(PortabilityError::Integrity);
    }
    drop(opened);
    let verified = crate::MemoryEngine::open_for_tenant_with_embedding(
        staging,
        crate::RecallConfig::default(),
        tenant,
        embedding_space,
    )
    .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    drop(verified);
    Ok((records.len() as u64, vectors.len() as u64))
}

fn encode_value(value: &Value) -> Result<Vec<u8>, PortabilityError> {
    hyphae_query::encode_document(value).map_err(|_| PortabilityError::MalformedRecord)
}

#[allow(dead_code)]
fn filter_export(
    source: &Path,
    destination: &Path,
    selector: &ExportSelector,
) -> Result<(), PortabilityError> {
    fs::create_dir_all(destination)?;
    let source_manifest = read_manifest(source)?;
    let mut records = File::create(destination.join(RECORDS_FILE))?;
    let mut count = 0_u64;
    for line in BufReader::new(File::open(source.join(RECORDS_FILE))?).lines() {
        let line = line?;
        let record: RecordLine =
            serde_json::from_str(&line).map_err(|_| PortabilityError::MalformedRecord)?;
        let value = unhex(&record.value_hex)?;
        if !record_matches(&value, selector, selector.tenant_id())? {
            records.write_all(line.as_bytes())?;
            records.write_all(b"\n")?;
            count += 1;
        }
    }
    records.sync_all()?;
    let selected_keys = BufReader::new(File::open(destination.join(RECORDS_FILE))?)
        .lines()
        .map(|line| {
            let line = line.map_err(PortabilityError::Io)?;
            let record: RecordLine =
                serde_json::from_str(&line).map_err(|_| PortabilityError::MalformedRecord)?;
            Ok(record.key_hex)
        })
        .collect::<Result<BTreeSet<_>, PortabilityError>>()?;
    let mut vectors_file = File::create(destination.join(VECTORS_FILE))?;
    for line in BufReader::new(File::open(source.join(VECTORS_FILE))?).lines() {
        let line = line?;
        let vector: VectorLine =
            serde_json::from_str(&line).map_err(|_| PortabilityError::MalformedRecord)?;
        if selected_keys.contains(&vector.key_hex) {
            vectors_file.write_all(line.as_bytes())?;
            vectors_file.write_all(b"\n")?;
        }
    }
    vectors_file.sync_all()?;
    let vector_count = BufReader::new(File::open(destination.join(VECTORS_FILE))?)
        .lines()
        .count() as u64;
    let manifest = build_manifest(
        selector.clone(),
        source_manifest.checkpoint_sequence,
        source_manifest.snapshot_digest,
        count,
        vector_count,
        &destination.join(RECORDS_FILE),
        &destination.join(VECTORS_FILE),
    )?;
    write_manifest(destination, &manifest)
}

fn record_matches(
    value: &[u8],
    selector: &ExportSelector,
    tenant: &str,
) -> Result<bool, PortabilityError> {
    if matches!(selector, ExportSelector::Tenant { .. }) {
        let Value::Object(fields) =
            decode_document(value).map_err(|_| PortabilityError::MalformedRecord)?
        else {
            return Err(PortabilityError::MalformedRecord);
        };
        if let Some(Value::String(record_tenant)) = fields.get("tenant_id")
            && record_tenant != tenant
        {
            return Err(PortabilityError::Ownership);
        }
        return Ok(true);
    }
    let Value::Object(fields) =
        decode_document(value).map_err(|_| PortabilityError::MalformedRecord)?
    else {
        return Err(PortabilityError::MalformedRecord);
    };
    let string = |name: &str| match fields.get(name) {
        Some(Value::String(value)) => Some(value.as_str()),
        _ => None,
    };
    if string("tenant_id").is_some_and(|value| value != tenant) {
        return Err(PortabilityError::Ownership);
    }
    Ok(match selector {
        ExportSelector::Tenant { .. } => true,
        ExportSelector::User { user_id, .. } => {
            string("user_id").is_some_and(|value| value == user_id)
        }
        ExportSelector::Project {
            user_id,
            project_id,
            ..
        } => {
            string("user_id").is_some_and(|value| value == user_id)
                && string("project_id").is_some_and(|value| value == project_id)
        }
    })
}

fn build_manifest(
    selector: ExportSelector,
    checkpoint_sequence: u64,
    snapshot_digest: String,
    record_count: u64,
    vector_count: u64,
    records: &Path,
    vectors: &Path,
) -> Result<LogicalManifest, PortabilityError> {
    let records_blake3 = file_digest(records)?;
    let vectors_blake3 = file_digest(vectors)?;
    Ok(LogicalManifest {
        format: FORMAT.to_owned(),
        format_version: FORMAT_VERSION,
        selector,
        checkpoint_sequence,
        snapshot_digest,
        record_count,
        vector_count,
        root_blake3: root_digest(&records_blake3, &vectors_blake3),
        records_blake3,
        vectors_blake3,
    })
}

fn write_manifest(path: &Path, manifest: &LogicalManifest) -> Result<(), PortabilityError> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    fs::write(path.join("MANIFEST.json"), bytes)?;
    Ok(())
}

fn read_manifest(path: &Path) -> Result<LogicalManifest, PortabilityError> {
    let bytes = fs::read(path.join("MANIFEST.json"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err(PortabilityError::Manifest("manifest too large".to_owned()));
    }
    let manifest: LogicalManifest = serde_json::from_slice(&bytes)
        .map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    if manifest.format != FORMAT || manifest.format_version != FORMAT_VERSION {
        return Err(PortabilityError::UnsupportedVersion);
    }
    Ok(manifest)
}

fn verify_file(path: &Path, name: &str, expected: &str) -> Result<(), PortabilityError> {
    if file_digest(&path.join(name))? == expected {
        Ok(())
    } else {
        Err(PortabilityError::Integrity)
    }
}

fn file_digest(path: &Path) -> Result<String, PortabilityError> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn root_digest(records: &str, vectors: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"celiums-memory-logical-export/v1");
    hasher.update(RECORDS_FILE.as_bytes());
    hasher.update(records.as_bytes());
    hasher.update(VECTORS_FILE.as_bytes());
    hasher.update(vectors.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn write_blob(output: &mut Vec<u8>, value: &[u8]) -> Result<(), PortabilityError> {
    output.extend_from_slice(&(value.len() as u64).to_le_bytes());
    output.extend_from_slice(value);
    Ok(())
}

#[allow(dead_code)]
fn split_blobs(input: &[u8]) -> Result<(Vec<u8>, Vec<u8>), PortabilityError> {
    if input.len() < 16 {
        return Err(PortabilityError::Crypto);
    }
    let manifest_len = u64::from_le_bytes(input[..8].try_into().unwrap()) as usize;
    let manifest_end = 8usize
        .checked_add(manifest_len)
        .ok_or(PortabilityError::Crypto)?;
    if manifest_end + 8 > input.len() {
        return Err(PortabilityError::Crypto);
    }
    let snapshot_len =
        u64::from_le_bytes(input[manifest_end..manifest_end + 8].try_into().unwrap()) as usize;
    let snapshot_start = manifest_end + 8;
    let snapshot_end = snapshot_start
        .checked_add(snapshot_len)
        .ok_or(PortabilityError::Crypto)?;
    if snapshot_end != input.len() {
        return Err(PortabilityError::Crypto);
    }
    Ok((
        input[8..manifest_end].to_vec(),
        input[snapshot_start..snapshot_end].to_vec(),
    ))
}

#[allow(dead_code)]
fn directory_bytes(path: &Path) -> Result<u64, PortabilityError> {
    let mut bytes: u64 = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            bytes = bytes.saturating_add(entry.metadata()?.len());
        }
    }
    Ok(bytes)
}

#[allow(dead_code)]
fn directory_digest(path: &Path) -> Result<String, PortabilityError> {
    let mut files = fs::read_dir(path)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_file())
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    files.sort();
    let mut hasher = blake3::Hasher::new();
    for file in files {
        hasher.update(
            file.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_bytes(),
        );
        hasher.update(file_digest(&file)?.as_bytes());
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[allow(dead_code)]
fn plan_digest(plan: &MigrationPlan) -> Result<String, PortabilityError> {
    let mut copy = plan.clone();
    copy.plan_blake3.clear();
    let bytes =
        serde_json::to_vec(&copy).map_err(|error| PortabilityError::Manifest(error.to_string()))?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Result<Vec<u8>, PortabilityError> {
    if !value.len().is_multiple_of(2) {
        return Err(PortabilityError::MalformedRecord);
    }
    (0..value.len())
        .step_by(2)
        .map(|offset| {
            u8::from_str_radix(&value[offset..offset + 2], 16)
                .map_err(|_| PortabilityError::MalformedRecord)
        })
        .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
