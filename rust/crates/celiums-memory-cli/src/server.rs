// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Native Axum adapter for REST v1 and MCP Streamable HTTP.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::response::Response;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post, put};
use celiums_cognition::{ContentRole, DisclosureAuthority, MemoryPurpose, Scope};
use celiums_memory_engine::{
    AgentId, EmbeddingSpaceIdentity, IdempotencyKey, MemoryEngine, MemoryEngineError,
    MemoryIdentity, MemoryPatch, ProjectId, Provenance, RecallConfig, RecallOptions, RecallRequest,
    RecallScope, RememberContext, RememberRequest, SessionId, SourceKind, TenantId,
    UpdateMemoryRequest, UserId, deterministic_embed,
};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::{Stream, wrappers::ReceiverStream};
use uuid::Uuid;

use crate::mcp;

const DEFAULT_BODY_LIMIT: usize = 1024 * 1024;
const MCP_PROTOCOL: &str = "2025-11-25";
const REQUEST_ID_HEADER: &str = "x-celiums-request-id";
const MCP_SESSION_HEADER: &str = "mcp-session-id";
const MCP_VERSION_HEADER: &str = "mcp-protocol-version";

/// Native server configuration.
#[derive(Clone)]
pub struct ServerConfig {
    /// Loopback bind by default.
    pub bind: SocketAddr,
    /// Root containing one opaque subdirectory per tenant.
    pub data_root: PathBuf,
    /// Embedding vector dimension.
    pub dimension: u16,
    /// Embedding-space identity shared by tenant engines.
    pub embedding_space: EmbeddingSpaceIdentity,
    /// Static API key records indexed by presented token.
    pub api_keys: BTreeMap<String, Principal>,
    /// Server-side pepper for stored API-key digests.
    pub api_key_pepper: String,
    /// OIDC verifier interface; `None` disables bearer JWT auth.
    pub oidc: Option<Arc<dyn OidcVerifier>>,
    /// Optional protected-resource metadata for OIDC-capable clients.
    pub oidc_metadata: Option<OidcMetadata>,
    /// Per-principal short-window request limit.
    pub request_limit: u64,
    /// Window duration.
    pub request_window: Duration,
    /// Long-window write quota.
    pub write_quota: u64,
    /// Long-window quota duration.
    pub write_quota_window: Duration,
    /// Confirmation secret.
    pub confirmation_secret: String,
    /// Optional exact Origin allowlist.
    pub allowed_origins: Vec<String>,
    /// Complete HTTP body limit.
    pub body_limit: usize,
    /// Maximum resident tenant actors; actors remain resident until shutdown.
    pub max_tenant_engines: usize,
    /// Maximum active MCP sessions.
    pub max_mcp_sessions: usize,
    /// Maximum pending confirmation records.
    pub max_confirmations: usize,
    /// Optional key used by checkpoint export/import.
    pub checkpoint_key: Option<[u8; 32]>,
    /// Maximum binary checkpoint artifact size.
    pub checkpoint_body_limit: usize,
}

impl ServerConfig {
    /// Creates safe loopback defaults for one local tenant key.
    pub fn local(data_root: PathBuf, api_key: String, dimension: u16) -> Self {
        let principal = Principal {
            tenant_id: TenantId::new("local").expect("static tenant"),
            user_id: UserId::new("local").expect("static user"),
            subject: "local".to_owned(),
            role: Role::Owner,
        };
        Self {
            bind: "127.0.0.1:3210".parse().expect("static socket"),
            data_root,
            dimension,
            embedding_space: EmbeddingSpaceIdentity::deterministic(dimension),
            api_keys: BTreeMap::from([(api_key, principal)]),
            api_key_pepper: Uuid::now_v7().to_string(),
            oidc: None,
            oidc_metadata: None,
            request_limit: 120,
            request_window: Duration::from_secs(60),
            write_quota: 10_000,
            write_quota_window: Duration::from_secs(24 * 60 * 60),
            confirmation_secret: Uuid::now_v7().to_string(),
            allowed_origins: Vec::new(),
            body_limit: DEFAULT_BODY_LIMIT,
            max_tenant_engines: 100,
            max_mcp_sessions: 1_000,
            max_confirmations: 1_000,
            checkpoint_key: None,
            checkpoint_body_limit: 512 * 1024 * 1024,
        }
    }
}

/// Server-authenticated identity. Request payloads never choose these fields.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Principal {
    /// Physical tenant.
    pub tenant_id: TenantId,
    /// Logical user.
    pub user_id: UserId,
    /// Authentication subject.
    pub subject: String,
    /// RBAC role.
    pub role: Role,
}

/// Five-level authority hierarchy.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Role {
    /// Read-only consumer.
    Reader,
    /// Read/write memory user.
    Writer,
    /// Tenant maintainer.
    Maintainer,
    /// Security auditor.
    Auditor,
    /// Tenant owner.
    Owner,
}

/// Native OIDC verification boundary; provider/JWKS I/O stays outside policy code.
pub trait OidcVerifier: Send + Sync + std::fmt::Debug {
    /// Verifies issuer/audience/time/signature and returns one trusted principal.
    fn verify(&self, token: &str, now_ms: i64) -> Result<Principal, AuthError>;
}

/// OIDC protected-resource discovery metadata.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OidcMetadata {
    /// Canonical protected-resource URL.
    pub resource: String,
    /// Trusted authorization server issuer.
    pub authorization_servers: Vec<String>,
    /// Scopes understood by this server.
    pub scopes_supported: Vec<String>,
}

/// Authentication failure with intentionally uniform public treatment.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AuthError {
    /// Credential was absent, unknown, expired or invalid.
    #[error("invalid credential")]
    InvalidCredential,
}

#[derive(Clone)]
struct AppState {
    config: Arc<ServerConfig>,
    api_keys: Arc<BTreeMap<[u8; 32], Principal>>,
    engines: Arc<Mutex<HashMap<String, TenantEngine>>>,
    engine_opening: Arc<tokio::sync::Mutex<()>>,
    mcp_sessions: Arc<Mutex<HashMap<String, McpHttpSession>>>,
    limits: Arc<Mutex<HashMap<String, LimitState>>>,
    confirmations: Arc<Mutex<HashMap<String, ConfirmationState>>>,
    started_at: Instant,
}

#[derive(Clone)]
struct TenantEngine {
    sender: mpsc::Sender<EngineCommand>,
}

enum EngineCommand {
    Execute {
        operation: Box<EngineOperation>,
        response: oneshot::Sender<EngineOutcome>,
    },
    Mcp {
        message: Value,
        authority: DisclosureAuthority,
        purpose: MemoryPurpose,
        response: oneshot::Sender<McpActorOutcome>,
    },
}

struct McpActorOutcome {
    response: Option<Value>,
    resource_changes: Vec<mcp::ResourceChange>,
}

struct EngineOutcome {
    result: Result<Value, ServiceError>,
    resource_change: Option<mcp::ResourceChange>,
}

enum EngineOperation {
    Remember(RememberDto, Principal),
    Recall(RecallDto, Principal),
    List(Principal, ScopeDto),
    Get(String, Principal, ScopeDto),
    Update(String, UpdateDto, Principal, ScopeDto),
    Delete(String, Principal, ScopeDto),
    CheckpointExport { output: PathBuf, key: [u8; 32] },
}

struct McpHttpSession {
    principal: Principal,
    initialized: bool,
    notification_sender: mpsc::Sender<Value>,
    notification_receiver: Arc<Mutex<Option<mpsc::Receiver<Value>>>>,
    notification_dirty: Arc<AtomicBool>,
    subscriptions: BTreeSet<String>,
    stream_active: Arc<AtomicBool>,
    expires_at: Instant,
}

struct LimitState {
    window_started: Instant,
    quota_started: Instant,
    requests: u64,
    writes: u64,
}

struct ConfirmationState {
    principal: String,
    tenant_id: String,
    user_id: String,
    role: Role,
    operation: String,
    resource_id: String,
    expires_at_ms: i64,
    used: bool,
}

/// Builds the complete native router.
pub fn router(config: ServerConfig) -> Router {
    let api_keys = config
        .api_keys
        .iter()
        .map(|(key, principal)| {
            (
                api_key_digest(&config.api_key_pepper, key),
                principal.clone(),
            )
        })
        .collect();
    let mut stored_config = config;
    stored_config.api_keys.clear();
    let state = AppState {
        config: Arc::new(stored_config),
        api_keys: Arc::new(api_keys),
        engines: Arc::new(Mutex::new(HashMap::new())),
        engine_opening: Arc::new(tokio::sync::Mutex::new(())),
        mcp_sessions: Arc::new(Mutex::new(HashMap::new())),
        limits: Arc::new(Mutex::new(HashMap::new())),
        confirmations: Arc::new(Mutex::new(HashMap::new())),
        started_at: Instant::now(),
    };
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/version", get(version))
        .route("/openapi.json", get(openapi))
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_protected_resource),
        )
        .route("/mcp", post(post_mcp).get(get_mcp).delete(delete_mcp))
        .route(
            "/v1/memories",
            post(remember).get(list_memories).fallback(http_fallback),
        )
        .route(
            "/v1/memories/{id}",
            get(get_memory)
                .patch(update_memory)
                .delete(delete_memory)
                .fallback(http_fallback),
        )
        .route("/v1/recall", post(recall))
        .route("/v1/confirmations", post(issue_confirmation))
        .route("/v1/checkpoints/export", post(export_checkpoint))
        .route(
            "/v1/checkpoints/export/{checkpoint_id}",
            get(get_checkpoint),
        )
        .route("/v1/checkpoints/import", put(import_checkpoint))
        .fallback(http_fallback)
        .with_state(state)
}

async fn http_fallback(request: Request) -> Response {
    let request_id = request_id(request.headers());
    error_response(ServiceError::NotFound, &request_id)
}

async fn export_checkpoint(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, Capability::Maintenance) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    let Some(key) = state.config.checkpoint_key else {
        return error_response(ServiceError::Unavailable, &request_id);
    };
    let tenant_engine = match tenant_engine(&state, &principal).await {
        Ok(engine) => engine,
        Err(error) => return error_response(error, &request_id),
    };
    let checkpoint_id = request
        .headers()
        .get("x-celiums-operation-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| valid_checkpoint_id(value))
        .map_or_else(|| Uuid::now_v7().simple().to_string(), str::to_owned);
    let output = checkpoint_directory(&state, &principal.tenant_id, &checkpoint_id);
    if output.join("checkpoint.artifact").exists() {
        let (metadata, _) = match celiums_memory_engine::read_encrypted_backup_artifact(&output) {
            Ok(result) => result,
            Err(_) => return error_response(ServiceError::InvalidCheckpoint, &request_id),
        };
        return json_response(StatusCode::CREATED, json!({
            "checkpoint_id": checkpoint_id,
            "format_version": metadata.format_version,
            "checkpoint_sequence": metadata.checkpoint_sequence,
            "snapshot_digest": metadata.snapshot_digest,
            "ciphertext_blake3": metadata.ciphertext_blake3,
            "ciphertext_bytes": metadata.ciphertext_bytes,
            "plaintext_bytes": metadata.plaintext_bytes,
        }), Some(&request_id));
    }
    let (sender, receiver) = oneshot::channel();
    if tenant_engine
        .sender
        .try_send(EngineCommand::Execute {
            operation: Box::new(EngineOperation::CheckpointExport { output, key }),
            response: sender,
        })
        .is_err()
    {
        return error_response(ServiceError::Unavailable, &request_id);
    }
    match receiver.await {
        Ok(outcome) => match outcome.result {
            Ok(mut value) => {
                value["checkpoint_id"] = json!(checkpoint_id);
                value["path"] = Value::Null;
                json_response(StatusCode::CREATED, value, Some(&request_id))
            }
            Err(error) => error_response(error, &request_id),
        },
        Err(_) => error_response(ServiceError::Unavailable, &request_id),
    }
}

async fn get_checkpoint(
    State(state): State<AppState>,
    AxumPath(checkpoint_id): AxumPath<String>,
    request: Request,
) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, Capability::Read) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    if !valid_checkpoint_id(&checkpoint_id) {
        return error_response(
            ServiceError::InvalidRequest("invalid checkpoint id"),
            &request_id,
        );
    }
    let artifact = checkpoint_directory(&state, &principal.tenant_id, &checkpoint_id)
        .join("checkpoint.artifact");
    let bytes = match fs::read(artifact) {
        Ok(bytes) => bytes,
        Err(_) => return error_response(ServiceError::NotFound, &request_id),
    };
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.celiums.checkpoint"),
    );
    insert_request_id(&mut response, &request_id);
    response
}

async fn import_checkpoint(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, Capability::Maintenance) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    let Some(key) = state.config.checkpoint_key else {
        return error_response(ServiceError::Unavailable, &request_id);
    };
    if registered_engine(&state, &principal.tenant_id).is_some() {
        return error_response(ServiceError::Conflict, &request_id);
    }
    let destination = state
        .config
        .data_root
        .join(opaque_tenant_directory(&principal.tenant_id));
    if destination.exists() {
        return error_response(ServiceError::Conflict, &request_id);
    }
    let bytes =
        match axum::body::to_bytes(request.into_body(), state.config.checkpoint_body_limit).await {
            Ok(bytes) => bytes,
            Err(_) => return error_response(ServiceError::PayloadTooLarge, &request_id),
        };
    let embedding = state.config.embedding_space.clone();
    let tenant = principal.tenant_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        let report =
            celiums_memory_engine::restore_encrypted_backup_artifact(&bytes, &destination, &key)
                .map_err(|_| ServiceError::InvalidCheckpoint)?;
        MemoryEngine::open_for_tenant_with_embedding(
            &destination,
            RecallConfig::default(),
            tenant,
            embedding,
        )
        .map_err(ServiceError::from_engine)?;
        Ok::<_, ServiceError>(report)
    })
    .await;
    match result {
        Ok(Ok(report)) => json_response(
            StatusCode::CREATED,
            json!({
                "restored": true,
                "record_count": report.record_count,
                "vector_count": report.vector_count,
            }),
            Some(&request_id),
        ),
        Ok(Err(error)) => error_response(error, &request_id),
        Err(_) => error_response(ServiceError::Unavailable, &request_id),
    }
}

fn checkpoint_directory(state: &AppState, tenant_id: &TenantId, checkpoint_id: &str) -> PathBuf {
    state
        .config
        .data_root
        .join("checkpoints")
        .join(opaque_tenant_directory(tenant_id))
        .join(checkpoint_id)
}

fn valid_checkpoint_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Runs the native server until termination.
pub async fn serve(config: ServerConfig) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .map_err(|error| error.to_string())?;
    axum::serve(listener, router(config))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|error| error.to_string())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn healthz(headers: HeaderMap) -> Response {
    let request_id = request_id(&headers);
    json_response(StatusCode::OK, json!({"ok":true}), Some(&request_id))
}

async fn readyz(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = request_id(&headers);
    let ready = if state.config.data_root.exists() {
        state.config.data_root.is_dir()
    } else {
        std::fs::create_dir_all(&state.config.data_root).is_ok()
    };
    json_response(
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        json!({"ready":ready,"uptime_ms":state.started_at.elapsed().as_millis()}),
        Some(&request_id),
    )
}

async fn version(headers: HeaderMap) -> Response {
    let request_id = request_id(&headers);
    json_response(
        StatusCode::OK,
        json!({"version":env!("CARGO_PKG_VERSION")}),
        Some(&request_id),
    )
}

async fn openapi(headers: HeaderMap) -> Response {
    let request_id = request_id(&headers);
    json_response(StatusCode::OK, openapi_document(), Some(&request_id))
}

async fn oauth_protected_resource(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let request_id = request_id(&headers);
    match &state.config.oidc_metadata {
        Some(metadata) => json_response(
            StatusCode::OK,
            serde_json::to_value(metadata).unwrap_or(Value::Null),
            Some(&request_id),
        ),
        None => error_response(ServiceError::NotFound, &request_id),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RememberDto {
    content: String,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    importance: Option<f64>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecallDto {
    query: String,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
    #[serde(default = "default_recall_limit")]
    limit: usize,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct ScopeDto {
    project_id: Option<String>,
    conversation_id: Option<String>,
    session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct UpdateDto {
    if_revision: u64,
    #[serde(default)]
    importance: Option<f64>,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
struct ConfirmationRequest {
    operation: String,
    resource_id: String,
}

fn default_recall_limit() -> usize {
    10
}

async fn remember(State(state): State<AppState>, request: Request) -> Response {
    execute_json(
        state,
        request,
        Capability::Write,
        true,
        |value, principal| {
            let dto: RememberDto = decode(value)?;
            Ok(EngineOperation::Remember(dto, principal))
        },
    )
    .await
}

async fn recall(State(state): State<AppState>, request: Request) -> Response {
    execute_json(
        state,
        request,
        Capability::Read,
        false,
        |value, principal| {
            let dto: RecallDto = decode(value)?;
            Ok(EngineOperation::Recall(dto, principal))
        },
    )
    .await
}

async fn list_memories(State(state): State<AppState>, request: Request) -> Response {
    let requested_scope = scope_from_query(request.uri().query());
    execute_empty(state, request, Capability::Read, |principal| {
        EngineOperation::List(principal, requested_scope)
    })
    .await
}

async fn get_memory(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    request: Request,
) -> Response {
    let requested_scope = scope_from_query(request.uri().query());
    execute_empty(state, request, Capability::Read, |principal| {
        EngineOperation::Get(id, principal, requested_scope)
    })
    .await
}

async fn update_memory(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    request: Request,
) -> Response {
    let requested_scope = scope_from_query(request.uri().query());
    execute_json(
        state,
        request,
        Capability::Write,
        true,
        |value, principal| {
            let dto: UpdateDto = decode(value)?;
            Ok(EngineOperation::Update(id, dto, principal, requested_scope))
        },
    )
    .await
}

async fn delete_memory(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    request: Request,
) -> Response {
    let request_id = request_id(request.headers());
    let requested_scope = scope_from_query(request.uri().query());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, Capability::Delete) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    if let Err(error) = consume_limit(&state, &principal, true) {
        return error_response(error, &request_id);
    }
    let token = request
        .headers()
        .get("x-celiums-confirmation")
        .and_then(|value| value.to_str().ok());
    if !consume_confirmation(&state, token, &principal, "memory_delete", &id) {
        return error_response(
            ServiceError::ConfirmationRequired {
                operation: "memory_delete".to_owned(),
                resource_id: id,
            },
            &request_id,
        );
    }
    dispatch_without_limit(
        &state,
        &principal,
        EngineOperation::Delete(id, principal.clone(), requested_scope),
        true,
        &request_id,
    )
    .await
}

async fn issue_confirmation(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, Capability::Delete) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    if let Err(error) = consume_limit(&state, &principal, false) {
        return error_response(error, &request_id);
    }
    let value = match read_json(request, state.config.body_limit).await {
        Ok(value) => value,
        Err(error) => return error_response(error, &request_id),
    };
    let confirmation: ConfirmationRequest = match decode(value) {
        Ok(value) => value,
        Err(error) => return error_response(error, &request_id),
    };
    if !matches!(
        confirmation.operation.as_str(),
        "memory_delete" | "run_lifecycle"
    ) || confirmation.resource_id.is_empty()
        || confirmation.resource_id.len() > 255
        || (confirmation.operation == "run_lifecycle" && confirmation.resource_id != "tenant")
    {
        return error_response(
            ServiceError::InvalidRequest("invalid confirmation target"),
            &request_id,
        );
    }
    let expires_at_ms = now_ms().saturating_add(5 * 60 * 1_000);
    let nonce = Uuid::now_v7().to_string();
    let token = confirmation_token(
        &state.config.confirmation_secret,
        &principal,
        &confirmation.operation,
        &confirmation.resource_id,
        expires_at_ms,
        &nonce,
    );
    let mut confirmations = state.confirmations.lock().expect("confirmation lock");
    let now = now_ms();
    confirmations.retain(|_, value| !value.used && value.expires_at_ms >= now);
    if confirmations.len() >= state.config.max_confirmations {
        return error_response(ServiceError::RateLimited, &request_id);
    }
    confirmations.insert(
        token.clone(),
        ConfirmationState {
            principal: principal.subject,
            tenant_id: principal.tenant_id.to_string(),
            user_id: principal.user_id.to_string(),
            role: principal.role,
            operation: confirmation.operation,
            resource_id: confirmation.resource_id,
            expires_at_ms,
            used: false,
        },
    );
    drop(confirmations);
    json_response(
        StatusCode::CREATED,
        json!({"token":token,"expires_at_ms":expires_at_ms}),
        Some(&request_id),
    )
}

async fn execute_json(
    state: AppState,
    request: Request,
    capability: Capability,
    write: bool,
    build: impl FnOnce(Value, Principal) -> Result<EngineOperation, ServiceError>,
) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if let Err(error) = consume_limit(&state, &principal, write) {
        return error_response(error, &request_id);
    }
    if !allows(principal.role, capability) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    let value = match read_json(request, state.config.body_limit).await {
        Ok(value) => value,
        Err(error) => return error_response(error, &request_id),
    };
    let operation = match build(value, principal.clone()) {
        Ok(operation) => operation,
        Err(error) => return error_response(error, &request_id),
    };
    dispatch_without_limit(&state, &principal, operation, write, &request_id).await
}

async fn execute_empty(
    state: AppState,
    request: Request,
    capability: Capability,
    build: impl FnOnce(Principal) -> EngineOperation,
) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if !allows(principal.role, capability) {
        return error_response(ServiceError::Forbidden, &request_id);
    }
    dispatch(
        &state,
        &principal,
        build(principal.clone()),
        false,
        &request_id,
    )
    .await
}

async fn dispatch(
    state: &AppState,
    principal: &Principal,
    operation: EngineOperation,
    write: bool,
    request_id: &str,
) -> Response {
    if let Err(error) = consume_limit(state, principal, write) {
        return error_response(error, request_id);
    }
    dispatch_without_limit(state, principal, operation, write, request_id).await
}

async fn dispatch_without_limit(
    state: &AppState,
    principal: &Principal,
    operation: EngineOperation,
    write: bool,
    request_id: &str,
) -> Response {
    let tenant_engine = match tenant_engine(state, principal).await {
        Ok(engine) => engine,
        Err(error) => return error_response(error, request_id),
    };
    let (sender, receiver) = oneshot::channel();
    if tenant_engine
        .sender
        .try_send(EngineCommand::Execute {
            operation: Box::new(operation),
            response: sender,
        })
        .is_err()
    {
        return error_response(ServiceError::Unavailable, request_id);
    }
    if write {
        match receiver.await {
            Ok(outcome) => match outcome.result {
                Ok(value) => {
                    if let Some(change) = outcome.resource_change {
                        publish_resource_change(state, principal, &change);
                    }
                    json_response(StatusCode::OK, value, Some(request_id))
                }
                Err(error) => error_response(error, request_id),
            },
            Err(_) => error_response(ServiceError::Unavailable, request_id),
        }
    } else {
        match tokio::time::timeout(Duration::from_secs(30), receiver).await {
            Ok(Ok(outcome)) => match outcome.result {
                Ok(value) => json_response(StatusCode::OK, value, Some(request_id)),
                Err(error) => error_response(error, request_id),
            },
            Ok(Err(_)) | Err(_) => error_response(ServiceError::Unavailable, request_id),
        }
    }
}

fn rest_resource_change(operation: &EngineOperation) -> Option<mcp::ResourceChange> {
    match operation {
        EngineOperation::Delete(..) => Some(mcp::ResourceChange {
            list_changed: true,
            updated_uris: BTreeSet::new(),
            tenant_wide: false,
        }),
        EngineOperation::Update(id, _, principal, requested_scope) => {
            let mut parameters = vec![
                format!("tenant_id={}", uri_encode(principal.tenant_id.as_str())),
                format!("user_id={}", uri_encode(principal.user_id.as_str())),
            ];
            for (name, value) in [
                ("project_id", requested_scope.project_id.as_deref()),
                (
                    "conversation_id",
                    requested_scope.conversation_id.as_deref(),
                ),
                ("session_id", requested_scope.session_id.as_deref()),
            ] {
                if let Some(value) = value {
                    parameters.push(format!("{name}={}", uri_encode(value)));
                }
            }
            Some(mcp::ResourceChange {
                list_changed: false,
                updated_uris: BTreeSet::from([format!(
                    "celiums-memory://memories/{id}?{}",
                    parameters.join("&")
                )]),
                tenant_wide: false,
            })
        }
        EngineOperation::Remember(..)
        | EngineOperation::Recall(..)
        | EngineOperation::List(..)
        | EngineOperation::Get(..)
        | EngineOperation::CheckpointExport { .. } => None,
    }
}

async fn tenant_engine(
    state: &AppState,
    principal: &Principal,
) -> Result<TenantEngine, ServiceError> {
    if let Some(engine) = registered_engine(state, &principal.tenant_id) {
        return Ok(engine);
    }
    let _opening = state.engine_opening.lock().await;
    if let Some(engine) = registered_engine(state, &principal.tenant_id) {
        return Ok(engine);
    }
    if state.engines.lock().expect("engine registry").len() >= state.config.max_tenant_engines {
        return Err(ServiceError::Unavailable);
    }
    let tenant_path = state
        .config
        .data_root
        .join(opaque_tenant_directory(&principal.tenant_id));
    let tenant = principal.tenant_id.clone();
    let embedding = state.config.embedding_space.clone();
    let open_path = tenant_path.clone();
    let engine = tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&open_path).map_err(|_| ServiceError::Unavailable)?;
        MemoryEngine::open_for_tenant_with_embedding(
            &open_path,
            RecallConfig::default(),
            tenant,
            embedding,
        )
        .map_err(ServiceError::from_engine)
    })
    .await
    .map_err(|_| ServiceError::Unavailable)??;
    let (sender, receiver) = mpsc::channel(128);
    let dimension = state.config.dimension;
    std::thread::Builder::new()
        .name(format!("celiums-tenant-{}", principal.tenant_id))
        .spawn(move || engine_actor(engine, receiver, dimension, tenant_path))
        .map_err(|_| ServiceError::Unavailable)?;
    let tenant_engine = TenantEngine { sender };
    state
        .engines
        .lock()
        .expect("engine registry")
        .insert(principal.tenant_id.to_string(), tenant_engine.clone());
    Ok(tenant_engine)
}

fn registered_engine(state: &AppState, tenant_id: &TenantId) -> Option<TenantEngine> {
    let mut engines = state.engines.lock().expect("engine registry");
    engines.retain(|_, engine| !engine.sender.is_closed());
    let engine = engines.get(tenant_id.as_str()).cloned()?;
    Some(engine)
}

fn engine_actor(
    engine: MemoryEngine,
    mut receiver: mpsc::Receiver<EngineCommand>,
    dimension: u16,
    data_dir: PathBuf,
) {
    let mut session = mcp::Session::new(engine, dimension, data_dir);
    initialize_internal_mcp(&mut session);
    while let Some(command) = receiver.blocking_recv() {
        match command {
            EngineCommand::Execute {
                operation,
                response,
            } => {
                if !response.is_closed() {
                    let remember = matches!(*operation, EngineOperation::Remember(..));
                    let before_count = remember
                        .then(|| session.engine_mut().count().ok())
                        .flatten();
                    let planned_change = rest_resource_change(&operation);
                    let result = execute_engine(session.engine_mut(), *operation);
                    let remember_changed = before_count.is_some_and(|before| {
                        session
                            .engine_mut()
                            .count()
                            .is_ok_and(|after| after > before)
                    });
                    let resource_change = if result.is_ok() && remember_changed {
                        Some(mcp::ResourceChange {
                            list_changed: true,
                            updated_uris: BTreeSet::new(),
                            tenant_wide: false,
                        })
                    } else if result.is_ok() {
                        planned_change
                    } else {
                        None
                    };
                    let _ignored = response.send(EngineOutcome {
                        result,
                        resource_change,
                    });
                }
            }
            EngineCommand::Mcp {
                message,
                authority,
                purpose,
                response,
            } => {
                if !response.is_closed() {
                    let _discarded_stdio_notifications = session.drain_notifications();
                    let outcome = McpActorOutcome {
                        response: session.handle_authenticated(&message, authority, purpose),
                        resource_changes: session.drain_resource_changes(),
                    };
                    let _discarded_stdio_notifications = session.drain_notifications();
                    let _ignored = response.send(outcome);
                }
            }
        }
    }
}

fn initialize_internal_mcp(session: &mut mcp::Session) {
    let _response = session.handle(&json!({
        "jsonrpc":"2.0","id":"internal-init","method":"initialize",
        "params":{
            "protocolVersion":MCP_PROTOCOL,
            "capabilities":{},
            "clientInfo":{"name":"celiums-memory-server","version":env!("CARGO_PKG_VERSION")}
        }
    }));
    let _notification = session.handle(&json!({
        "jsonrpc":"2.0","method":"notifications/initialized"
    }));
}

fn execute_engine(
    engine: &mut MemoryEngine,
    operation: EngineOperation,
) -> Result<Value, ServiceError> {
    match operation {
        EngineOperation::Remember(dto, principal) => {
            validate_content(&dto.content)?;
            let scope = parse_scope(dto.scope.as_deref())?;
            let context = context_from_principal(&principal, &dto.content, &dto, now_ms())?;
            let idempotency_key = dto
                .idempotency_key
                .map(IdempotencyKey::new)
                .transpose()
                .map_err(|_| ServiceError::InvalidRequest("invalid idempotency key"))?;
            let embedding = dto.embedding.unwrap_or_else(|| {
                deterministic_embed(&dto.content, engine.embedding_space().dimension)
            });
            let memory = engine
                .remember(RememberRequest {
                    content: dto.content,
                    embedding,
                    tags: dto.tags,
                    scope,
                    importance: dto.importance,
                    now_ms: now_ms(),
                    context: Some(context),
                    embedding_space: Some(engine.embedding_space().clone()),
                    idempotency_key,
                    content_role: ContentRole::Observation,
                    purpose: disclosure_purpose(principal.role),
                })
                .map_err(ServiceError::from_engine)?;
            Ok(json!({"id":memory.id,"revision":memory.revision}))
        }
        EngineOperation::Recall(dto, principal) => {
            if dto.limit == 0 || dto.limit > 50 {
                return Err(ServiceError::InvalidRequest("limit must be in 1..=50"));
            }
            let scope = recall_scope_from_principal(&principal, &dto)?;
            let embedding = dto.embedding.unwrap_or_else(|| {
                deterministic_embed(&dto.query, engine.embedding_space().dimension)
            });
            let response = engine
                .recall(RecallRequest {
                    query_text: dto.query,
                    embedding,
                    limit: dto.limit,
                    current_state: None,
                    now_ms: now_ms(),
                    scope: Some(scope),
                    embedding_space: Some(engine.embedding_space().clone()),
                    disclosure_authority: authority(principal.role),
                    disclosure_purpose: disclosure_purpose(principal.role),
                    options: RecallOptions::default(),
                })
                .map_err(ServiceError::from_engine)?;
            Ok(json!({
                "results":response.results.iter().map(|result| json!({
                    "id":result.memory.id,
                    "content":result.memory.content,
                    "score":result.final_score,
                    "citations":result.citations.iter().map(|citation| json!({
                        "memory_id":citation.memory_id,
                        "content_hash":citation.content_hash
                    })).collect::<Vec<_>>()
                })).collect::<Vec<_>>(),
                "abstention":response.overall_abstention.map(|reason| format!("{reason:?}").to_lowercase())
            }))
        }
        EngineOperation::List(principal, requested_scope) => {
            let scope = scope_for_principal(&principal, &requested_scope)?;
            let memories = engine
                .list_disclosed_memories(
                    &scope,
                    200,
                    authority(principal.role),
                    disclosure_purpose(principal.role),
                )
                .map_err(ServiceError::from_engine)?;
            Ok(json!({"memories":memories.iter().map(|memory| json!({
                "id":memory.id,"content":memory.content,"revision":memory.revision
            })).collect::<Vec<_>>()}))
        }
        EngineOperation::Get(id, principal, requested_scope) => {
            let memory = engine
                .get_disclosed_memory(celiums_memory_engine::DisclosedMemoryRequest {
                    id,
                    scope: scope_for_principal(&principal, &requested_scope)?,
                    disclosure_authority: authority(principal.role),
                    disclosure_purpose: disclosure_purpose(principal.role),
                })
                .map_err(ServiceError::from_engine)?;
            memory
                .map(|memory| json!({"id":memory.id,"content":memory.content,"revision":memory.revision}))
                .ok_or(ServiceError::NotFound)
        }
        EngineOperation::Update(id, dto, principal, requested_scope) => {
            let memory = engine
                .update_memory(UpdateMemoryRequest {
                    id,
                    scope: scope_for_principal(&principal, &requested_scope)?,
                    patch: MemoryPatch {
                        importance: dto.importance,
                        tags: dto.tags,
                        ..MemoryPatch::default()
                    },
                    if_revision: dto.if_revision,
                    now_ms: now_ms(),
                })
                .map_err(ServiceError::from_engine)?;
            memory
                .map(|memory| json!({"id":memory.id,"revision":memory.revision}))
                .ok_or(ServiceError::NotFound)
        }
        EngineOperation::Delete(id, principal, requested_scope) => {
            let outcome = engine
                .delete_memory(&id, &scope_for_principal(&principal, &requested_scope)?)
                .map_err(ServiceError::from_engine)?;
            if outcome.deleted {
                Ok(json!({"id":outcome.id,"deleted":true}))
            } else {
                Err(ServiceError::NotFound)
            }
        }
        EngineOperation::CheckpointExport { output, key } => {
            let info = engine
                .create_encrypted_backup(&output, &key)
                .map_err(|_| ServiceError::InvalidCheckpoint)?;
            Ok(json!({
                "checkpoint_sequence": info.checkpoint_sequence,
                "snapshot_digest": info.snapshot_digest,
                "ciphertext_blake3": info.ciphertext_blake3,
                "ciphertext_bytes": info.ciphertext_bytes,
                "plaintext_bytes": info.plaintext_bytes,
                "path": Value::Null,
            }))
        }
    }
}

fn context_from_principal(
    principal: &Principal,
    content: &str,
    dto: &RememberDto,
    now_ms: i64,
) -> Result<RememberContext, ServiceError> {
    match dto.scope.as_deref().unwrap_or("global") {
        "project" if dto.project_id.is_none() => {
            return Err(ServiceError::InvalidRequest(
                "project scope requires project_id",
            ));
        }
        "session" if dto.project_id.is_none() || dto.session_id.is_none() => {
            return Err(ServiceError::InvalidRequest(
                "session scope requires project_id and session_id",
            ));
        }
        _ => {}
    }
    Ok(RememberContext {
        identity: MemoryIdentity {
            tenant_id: principal.tenant_id.clone(),
            user_id: principal.user_id.clone(),
            agent_id: Some(
                AgentId::new(principal.subject.clone())
                    .map_err(|_| ServiceError::InvalidRequest("invalid subject"))?,
            ),
            project_id: dto
                .project_id
                .clone()
                .map(ProjectId::new)
                .transpose()
                .map_err(|_| ServiceError::InvalidRequest("invalid project_id"))?,
            conversation_id: dto
                .conversation_id
                .clone()
                .map(celiums_memory_engine::ConversationId::new)
                .transpose()
                .map_err(|_| ServiceError::InvalidRequest("invalid conversation_id"))?,
            session_id: dto
                .session_id
                .clone()
                .map(SessionId::new)
                .transpose()
                .map_err(|_| ServiceError::InvalidRequest("invalid session_id"))?,
        },
        provenance: Provenance::observed(
            SourceKind::User,
            content,
            None,
            None,
            Some(principal.subject.clone()),
        ),
        event_at_ms: None,
        ingested_at_ms: now_ms,
    })
}

fn recall_scope_from_principal(
    principal: &Principal,
    dto: &RecallDto,
) -> Result<RecallScope, ServiceError> {
    Ok(RecallScope {
        tenant_id: principal.tenant_id.clone(),
        user_id: principal.user_id.clone(),
        project_id: dto
            .project_id
            .clone()
            .map(ProjectId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid project_id"))?,
        conversation_id: dto
            .conversation_id
            .clone()
            .map(celiums_memory_engine::ConversationId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid conversation_id"))?,
        session_id: dto
            .session_id
            .clone()
            .map(SessionId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid session_id"))?,
    })
}

fn scope_from_query(query: Option<&str>) -> ScopeDto {
    let mut scope = ScopeDto::default();
    for pair in query
        .unwrap_or_default()
        .split('&')
        .filter(|pair| !pair.is_empty())
    {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let value = percent_decode_str(value)
            .decode_utf8()
            .map_or_else(|_| value.to_owned(), |value| value.into_owned());
        match name {
            "project_id" => scope.project_id = Some(value),
            "conversation_id" => scope.conversation_id = Some(value),
            "session_id" => scope.session_id = Some(value),
            _ => {}
        }
    }
    scope
}

fn scope_for_principal(
    principal: &Principal,
    scope: &ScopeDto,
) -> Result<RecallScope, ServiceError> {
    Ok(RecallScope {
        tenant_id: principal.tenant_id.clone(),
        user_id: principal.user_id.clone(),
        project_id: scope
            .project_id
            .clone()
            .map(ProjectId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid project_id"))?,
        conversation_id: scope
            .conversation_id
            .clone()
            .map(celiums_memory_engine::ConversationId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid conversation_id"))?,
        session_id: scope
            .session_id
            .clone()
            .map(SessionId::new)
            .transpose()
            .map_err(|_| ServiceError::InvalidRequest("invalid session_id"))?,
    })
}

fn parse_scope(scope: Option<&str>) -> Result<Scope, ServiceError> {
    match scope.unwrap_or("global") {
        "global" => Ok(Scope::Global),
        "project" => Ok(Scope::Project),
        "session" => Ok(Scope::Session),
        _ => Err(ServiceError::InvalidRequest("invalid scope")),
    }
}

fn validate_content(content: &str) -> Result<(), ServiceError> {
    if content.trim().is_empty() || content.len() > 64 * 1024 {
        Err(ServiceError::InvalidRequest(
            "content must be 1..=65536 bytes",
        ))
    } else {
        Ok(())
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ServiceError> {
    serde_json::from_value(value).map_err(|_| ServiceError::InvalidRequest("invalid JSON shape"))
}

async fn read_json(request: Request, maximum: usize) -> Result<Value, ServiceError> {
    let content_type = request
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if content_type
        .split(';')
        .next()
        .is_none_or(|value| value.trim() != "application/json")
    {
        return Err(ServiceError::UnsupportedMediaType);
    }
    let bytes = axum::body::to_bytes(request.into_body(), maximum)
        .await
        .map_err(|_| ServiceError::PayloadTooLarge)?;
    serde_json::from_slice(&bytes).map_err(|_| ServiceError::InvalidRequest("invalid JSON"))
}

#[derive(Clone, Copy)]
enum Capability {
    Read,
    TenantRead,
    Write,
    Delete,
    Maintenance,
}

fn allows(role: Role, capability: Capability) -> bool {
    match (role, capability) {
        (_, Capability::Read) => true,
        (Role::Maintainer | Role::Auditor | Role::Owner, Capability::TenantRead) => true,
        (Role::Writer | Role::Maintainer | Role::Owner, Capability::Write) => true,
        (Role::Maintainer | Role::Owner, Capability::Delete) => true,
        (Role::Maintainer | Role::Owner, Capability::Maintenance) => true,
        (Role::Reader | Role::Auditor, Capability::Write) => false,
        (Role::Reader | Role::Writer, Capability::TenantRead) => false,
        (
            Role::Reader | Role::Writer | Role::Auditor,
            Capability::Delete | Capability::Maintenance,
        ) => false,
    }
}

fn authority(role: Role) -> DisclosureAuthority {
    match role {
        Role::Reader | Role::Writer | Role::Maintainer => DisclosureAuthority::Agent,
        Role::Auditor => DisclosureAuthority::Auditor,
        Role::Owner => DisclosureAuthority::Owner,
    }
}

fn disclosure_purpose(role: Role) -> MemoryPurpose {
    if role == Role::Auditor {
        MemoryPurpose::SafetyAudit
    } else {
        MemoryPurpose::ConversationalContext
    }
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<Principal, ServiceError> {
    validate_origin(state, headers)?;
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(ServiceError::Unauthenticated)?;
    let digest = api_key_digest(&state.config.api_key_pepper, authorization);
    if let Some(principal) = state.api_keys.get(&digest) {
        return Ok(principal.clone());
    }
    if let Some(oidc) = &state.config.oidc {
        return oidc
            .verify(authorization, now_ms())
            .map_err(|_| ServiceError::Unauthenticated);
    }
    Err(ServiceError::Unauthenticated)
}

fn validate_origin(state: &AppState, headers: &HeaderMap) -> Result<(), ServiceError> {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(());
    };
    if state
        .config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(())
    } else {
        Err(ServiceError::Forbidden)
    }
}

fn consume_limit(state: &AppState, principal: &Principal, write: bool) -> Result<(), ServiceError> {
    let key = principal_limit_key(principal);
    let mut limits = state.limits.lock().expect("limit lock");
    let now = Instant::now();
    let entry = limits.entry(key).or_insert(LimitState {
        window_started: now,
        quota_started: now,
        requests: 0,
        writes: 0,
    });
    if now.duration_since(entry.window_started) >= state.config.request_window {
        entry.window_started = now;
        entry.requests = 0;
    }
    if now.duration_since(entry.quota_started) >= state.config.write_quota_window {
        entry.quota_started = now;
        entry.writes = 0;
    }
    if entry.requests >= state.config.request_limit {
        return Err(ServiceError::RateLimited);
    }
    if write && entry.writes >= state.config.write_quota {
        return Err(ServiceError::QuotaExceeded);
    }
    entry.requests += 1;
    entry.writes += u64::from(write);
    Ok(())
}

fn consume_write_quota(
    state: &AppState,
    principal: &Principal,
    writes: u64,
) -> Result<(), ServiceError> {
    let key = principal_limit_key(principal);
    let mut limits = state.limits.lock().expect("limit lock");
    let now = Instant::now();
    let entry = limits.entry(key).or_insert(LimitState {
        window_started: now,
        quota_started: now,
        requests: 0,
        writes: 0,
    });
    if now.duration_since(entry.quota_started) >= state.config.write_quota_window {
        entry.quota_started = now;
        entry.writes = 0;
    }
    if entry.writes.saturating_add(writes) > state.config.write_quota {
        return Err(ServiceError::QuotaExceeded);
    }
    entry.writes = entry.writes.saturating_add(writes);
    Ok(())
}

fn principal_limit_key(principal: &Principal) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [
        principal.tenant_id.as_str(),
        principal.user_id.as_str(),
        principal.subject.as_str(),
    ] {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn confirmation_token(
    secret: &str,
    principal: &Principal,
    operation: &str,
    resource_id: &str,
    expires_at_ms: i64,
    nonce: &str,
) -> String {
    let mut hasher = blake3::Hasher::new_keyed(blake3::hash(secret.as_bytes()).as_bytes());
    for field in [
        principal.tenant_id.as_str(),
        principal.user_id.as_str(),
        principal.subject.as_str(),
        role_name(principal.role),
        operation,
        resource_id,
        nonce,
    ] {
        hasher.update(&(field.len() as u64).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    hasher.update(&expires_at_ms.to_le_bytes());
    hasher.finalize().to_hex().to_string()
}

fn consume_confirmation(
    state: &AppState,
    token: Option<&str>,
    principal: &Principal,
    operation: &str,
    resource_id: &str,
) -> bool {
    let Some(token) = token else { return false };
    let mut confirmations = state.confirmations.lock().expect("confirmation lock");
    let Some(confirmation) = confirmations.get(token) else {
        return false;
    };
    if confirmation.used
        || confirmation.expires_at_ms < now_ms()
        || confirmation.principal != principal.subject
        || confirmation.tenant_id != principal.tenant_id.as_str()
        || confirmation.user_id != principal.user_id.as_str()
        || confirmation.role != principal.role
        || confirmation.operation != operation
        || confirmation.resource_id != resource_id
    {
        return false;
    }
    confirmations.remove(token);
    true
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Reader => "reader",
        Role::Writer => "writer",
        Role::Maintainer => "maintainer",
        Role::Auditor => "auditor",
        Role::Owner => "owner",
    }
}

fn opaque_tenant_directory(tenant_id: &TenantId) -> String {
    blake3::hash(tenant_id.as_str().as_bytes())
        .to_hex()
        .to_string()
}

fn api_key_digest(pepper: &str, key: &str) -> [u8; 32] {
    let key_material = blake3::hash(pepper.as_bytes());
    *blake3::keyed_hash(key_material.as_bytes(), key.as_bytes()).as_bytes()
}

async fn post_mcp(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    let accept = request
        .headers()
        .get(axum::http::header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let accepted = accept
        .split(',')
        .filter_map(|value| value.trim().split(';').next())
        .collect::<BTreeSet<_>>();
    if !accepted.contains("application/json") || !accepted.contains("text/event-stream") {
        return error_response(ServiceError::NotAcceptable, &request_id);
    }
    let supplied_session = request
        .headers()
        .get(MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if supplied_session.is_some()
        && request
            .headers()
            .get(MCP_VERSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|version| version != MCP_PROTOCOL)
    {
        return error_response(
            ServiceError::InvalidRequest("unsupported MCP protocol version"),
            &request_id,
        );
    }
    if let Err(error) = consume_limit(&state, &principal, false) {
        return error_response(error, &request_id);
    }
    let value = match read_json(request, state.config.body_limit).await {
        Ok(value) => value,
        Err(ServiceError::InvalidRequest(_)) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32700,"message":"Parse error"}}),
                Some(&request_id),
            );
        }
        Err(error) => return error_response(error, &request_id),
    };
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("method").and_then(Value::as_str).is_none()
    {
        return error_response(
            ServiceError::InvalidRequest("MCP HTTP accepts JSON-RPC requests and notifications"),
            &request_id,
        );
    }
    let method = value.get("method").and_then(Value::as_str);
    if method == Some("initialize") && (!valid_initialize(&value) || supplied_session.is_some()) {
        if value.get("id").is_none() {
            return error_response(
                ServiceError::InvalidRequest("initialize must be a JSON-RPC request"),
                &request_id,
            );
        }
        let invalid_id = value
            .get("id")
            .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64());
        return json_response(
            StatusCode::OK,
            if invalid_id {
                json!({"jsonrpc":"2.0","id":Value::Null,"error":{"code":-32600,"message":"Invalid Request"}})
            } else {
                json!({"jsonrpc":"2.0","id":value.get("id").cloned().unwrap_or(Value::Null),"error":{"code":-32602,"message":"Invalid initialize params"}})
            },
            Some(&request_id),
        );
    }
    let session_id = if method == Some("initialize") {
        let mut sessions = state.mcp_sessions.lock().expect("mcp sessions");
        sessions.retain(|_, session| session.expires_at >= Instant::now());
        if sessions.len() >= state.config.max_mcp_sessions {
            return error_response(ServiceError::RateLimited, &request_id);
        }
        let id = Uuid::now_v7().simple().to_string();
        let (notification_sender, notification_receiver) = mpsc::channel(128);
        sessions.insert(
            id.clone(),
            McpHttpSession {
                principal: principal.clone(),
                initialized: false,
                notification_sender,
                notification_receiver: Arc::new(Mutex::new(Some(notification_receiver))),
                notification_dirty: Arc::new(AtomicBool::new(false)),
                subscriptions: BTreeSet::new(),
                stream_active: Arc::new(AtomicBool::new(false)),
                expires_at: Instant::now() + Duration::from_secs(30 * 60),
            },
        );
        Some(id)
    } else {
        let Some(session_id) = supplied_session.as_deref() else {
            return error_response(
                ServiceError::InvalidRequest("missing MCP session"),
                &request_id,
            );
        };
        let valid = state
            .mcp_sessions
            .lock()
            .expect("mcp sessions")
            .get(session_id)
            .is_some_and(|session| {
                session.principal == principal && session.expires_at >= Instant::now()
            });
        if !valid {
            return error_response(ServiceError::NotFound, &request_id);
        }
        supplied_session
    };
    let response = mcp_protocol_response(&state, &principal, session_id.as_deref(), &value).await;
    if value.get("id").is_none() && response.is_some() {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::BAD_REQUEST;
        insert_request_id(&mut response, &request_id);
        return response;
    }
    let status = if value.get("id").is_none() {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    let mut response = match response {
        Some(value) => json_response(status, value, Some(&request_id)),
        None => {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = status;
            insert_request_id(&mut response, &request_id);
            response
        }
    };
    if let Some(session_id) = session_id {
        response.headers_mut().insert(
            HeaderName::from_static(MCP_SESSION_HEADER),
            HeaderValue::from_str(&session_id).expect("session header"),
        );
    }
    response
}

fn valid_initialize(value: &Value) -> bool {
    value.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && value
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_i64() || id.is_u64())
        && value
            .get("params")
            .and_then(|params| params.get("protocolVersion"))
            .and_then(Value::as_str)
            .is_some()
        && value
            .get("params")
            .and_then(|params| params.get("capabilities"))
            .is_some_and(Value::is_object)
        && value
            .get("params")
            .and_then(|params| params.get("clientInfo"))
            .is_some_and(Value::is_object)
}

async fn mcp_protocol_response(
    state: &AppState,
    principal: &Principal,
    session_id: Option<&str>,
    value: &Value,
) -> Option<Value> {
    let id = value.get("id").cloned().unwrap_or(Value::Null);
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if method == "initialize" {
        return Some(json!({
            "jsonrpc":"2.0","id":id,"result":{
                "protocolVersion":MCP_PROTOCOL,
                "capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":true,"listChanged":true}},
                "serverInfo":{"name":"celiums-memory","version":env!("CARGO_PKG_VERSION")}
            }
        }));
    }
    let Some(session_id) = session_id else {
        return Some(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Server not initialized"}}),
        );
    };
    {
        let mut sessions = state.mcp_sessions.lock().expect("mcp sessions");
        let Some(session) = sessions.get_mut(session_id) else {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Unknown session"}}),
            );
        };
        if session.principal != *principal || session.expires_at < Instant::now() {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Unknown session"}}),
            );
        }
        if method == "notifications/initialized" {
            if value.get("id").is_some() {
                return Some(json!({
                    "jsonrpc":"2.0","id":id,
                    "error":{"code":-32600,"message":"Invalid Request"}
                }));
            }
            session.initialized = true;
            return None;
        }
        if !session.initialized {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Server not initialized"}}),
            );
        }
    }
    if let Err(error) = authorize_mcp_operation(state, principal, value) {
        return Some(json!({
            "jsonrpc":"2.0","id":id,
            "result":{"content":[{"type":"text","text":error.to_string()}],"isError":true,"structuredContent":{"error":{"code":error.code()}}}
        }));
    }
    if matches!(method, "resources/subscribe" | "resources/unsubscribe") {
        let Some(uri) = value
            .get("params")
            .and_then(|params| params.get("uri"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Invalid params"}}),
            );
        };
        let canonical = canonical_resource_uri(&uri, principal);
        if method == "resources/subscribe" {
            let engine = match tenant_engine(state, principal).await {
                Ok(engine) => engine,
                Err(_) => {
                    return Some(
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Internal error"}}),
                    );
                }
            };
            let mut read = value.clone();
            read["method"] = Value::String("resources/read".to_owned());
            inject_mcp_identity(&mut read, principal);
            let (sender, receiver) = oneshot::channel();
            if engine
                .sender
                .try_send(EngineCommand::Mcp {
                    message: read,
                    authority: authority(principal.role),
                    purpose: disclosure_purpose(principal.role),
                    response: sender,
                })
                .is_err()
            {
                return Some(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Internal error"}}),
                );
            }
            let validation = receiver.await.ok().and_then(|outcome| outcome.response);
            if validation
                .as_ref()
                .is_none_or(|response| response.get("error").is_some())
            {
                return Some(json!({
                    "jsonrpc":"2.0","id":id,
                    "error":{"code":-32002,"message":"Resource not found"}
                }));
            }
        }
        let mut sessions = state.mcp_sessions.lock().expect("mcp sessions");
        let Some(session) = sessions.get_mut(session_id) else {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Unknown session"}}),
            );
        };
        if method == "resources/subscribe" {
            if session.subscriptions.len() >= 1_000 {
                return Some(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Subscription limit reached"}}),
                );
            }
            session.subscriptions.insert(canonical);
        } else {
            session.subscriptions.remove(&canonical);
        }
        return Some(json!({"jsonrpc":"2.0","id":id,"result":{}}));
    }
    let engine = match tenant_engine(state, principal).await {
        Ok(engine) => engine,
        Err(_) => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Internal error"}}),
            );
        }
    };
    let mut forwarded = value.clone();
    inject_mcp_identity(&mut forwarded, principal);
    let (sender, receiver) = oneshot::channel();
    if engine
        .sender
        .try_send(EngineCommand::Mcp {
            message: forwarded,
            authority: authority(principal.role),
            purpose: disclosure_purpose(principal.role),
            response: sender,
        })
        .is_err()
    {
        return Some(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Internal error"}}),
        );
    }
    let outcome = if mcp_request_mutates(value) {
        receiver.await.ok()
    } else {
        tokio::time::timeout(Duration::from_secs(30), receiver)
            .await
            .ok()
            .and_then(Result::ok)
    };
    let Some(outcome) = outcome else {
        return Some(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"Internal error"}}),
        );
    };
    for change in outcome.resource_changes {
        publish_resource_change(state, principal, &change);
    }
    outcome
        .response
        .map(|response| sanitize_remote_mcp_response(response, principal.role))
}

fn canonical_resource_uri(uri: &str, principal: &Principal) -> String {
    let (base, query) = uri.split_once('?').unwrap_or((uri, ""));
    let mut parameters = vec![
        format!("tenant_id={}", uri_encode(principal.tenant_id.as_str())),
        format!("user_id={}", uri_encode(principal.user_id.as_str())),
    ];
    let mut seen = BTreeSet::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        if matches!(name, "project_id" | "conversation_id" | "session_id")
            && !value.is_empty()
            && seen.insert(name)
        {
            let decoded = percent_decode_str(value)
                .decode_utf8()
                .map_or_else(|_| value.to_owned(), |value| value.into_owned());
            parameters.push(format!("{name}={}", uri_encode(&decoded)));
        }
    }
    format!("{base}?{}", parameters.join("&"))
}

fn uri_encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn publish_resource_change(state: &AppState, principal: &Principal, change: &mcp::ResourceChange) {
    let sessions = state.mcp_sessions.lock().expect("mcp sessions");
    for session in sessions.values().filter(|session| {
        session.principal.tenant_id == principal.tenant_id
            && (change.tenant_wide || session.principal.user_id == principal.user_id)
            && session.initialized
            && session.expires_at >= Instant::now()
    }) {
        if change.list_changed {
            let _ignored = enqueue_notification(
                &session.notification_sender,
                &session.notification_dirty,
                json!({
                "jsonrpc":"2.0","method":"notifications/resources/list_changed"
                }),
            );
        }
        for uri in session.subscriptions.iter().filter(|subscribed| {
            change.tenant_wide
                || change
                    .updated_uris
                    .iter()
                    .any(|changed| same_resource_uri(changed, subscribed))
        }) {
            let _ignored = enqueue_notification(
                &session.notification_sender,
                &session.notification_dirty,
                json!({
                    "jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":uri}
                }),
            );
        }
    }
}

fn enqueue_notification(
    sender: &mpsc::Sender<Value>,
    dirty: &AtomicBool,
    notification: Value,
) -> Result<(), ()> {
    match sender.try_send(notification) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(_)) => {
            dirty.store(true, Ordering::Release);
            Ok(())
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err(()),
    }
}

fn same_resource_uri(left: &str, right: &str) -> bool {
    left.split_once('?').map_or(left, |(base, _)| base)
        == right.split_once('?').map_or(right, |(base, _)| base)
}

fn sanitize_remote_mcp_response(mut response: Value, role: Role) -> Value {
    if response.get("error").is_some() {
        let id = response.get("id").cloned().unwrap_or(Value::Null);
        let code = response["error"]["code"].as_i64().unwrap_or(-32603);
        let message = match code {
            -32700 => "Parse error",
            -32600 => "Invalid Request",
            -32601 => "Method not found",
            -32602 => "Invalid params",
            _ => "Operation failed",
        };
        return json!({
            "jsonrpc":"2.0","id":id,
            "error":{"code":code,"message":message}
        });
    }
    if response
        .get("result")
        .and_then(|result| result.get("isError"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        let code = response["result"]["structuredContent"]["error"]["code"]
            .as_str()
            .unwrap_or("operation_failed")
            .to_owned();
        response["result"]["content"] = json!([{"type":"text","text":"Operation failed"}]);
        response["result"]["structuredContent"] = json!({"error":{"code":code}});
    }
    if let Some(result) = response.get_mut("result") {
        filter_remote_tools(result, role);
        remove_path_fields(result);
        if result.get("isError").and_then(Value::as_bool) != Some(true)
            && let Some(structured) = result.get("structuredContent")
            && let Ok(text) = serde_json::to_string(structured)
        {
            result["content"] = json!([{"type":"text","text":text}]);
        }
    }
    response
}

fn filter_remote_tools(result: &mut Value, role: Role) {
    let Some(tools) = result.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    tools.retain(|tool| {
        tool.get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| remote_tool_visible(role, name))
    });
    for tool in tools {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        if matches!(name, "memory_delete" | "run_lifecycle")
            && allows(
                role,
                if name == "memory_delete" {
                    Capability::Delete
                } else {
                    Capability::Maintenance
                },
            )
        {
            tool["inputSchema"]["required"] = if name == "memory_delete" {
                json!(["id", "confirmation_token"])
            } else {
                json!(["confirmation_token"])
            };
        }
    }
}

fn remote_tool_visible(role: Role, name: &str) -> bool {
    match name {
        "consolidate" => false,
        "confirm_destructive" => false,
        "memory_delete" => allows(role, Capability::Delete),
        "run_lifecycle" | "snapshot_now" => allows(role, Capability::Maintenance),
        "circadian_status" => allows(role, Capability::TenantRead),
        name if is_mcp_read_tool(name) => allows(role, Capability::Read),
        _ => allows(role, Capability::Write),
    }
}

fn remove_path_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("path");
            for value in object.values_mut() {
                remove_path_fields(value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(remove_path_fields),
        _ => {}
    }
}

fn authorize_mcp_operation(
    state: &AppState,
    principal: &Principal,
    value: &Value,
) -> Result<(), ServiceError> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tool = value
        .get("params")
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str);
    let (capability, write) = match (method, tool) {
        ("tools/call", Some("confirm_destructive")) => return Err(ServiceError::Forbidden),
        ("tools/call", Some("circadian_status")) => (Capability::TenantRead, false),
        ("tools/call", Some(name)) if is_mcp_read_tool(name) => (Capability::Read, false),
        ("tools/call", Some("memory_delete")) => (Capability::Delete, true),
        ("tools/call", Some("memory_update")) if mcp_update_changes_membership(value) => {
            (Capability::Maintenance, true)
        }
        ("tools/call", Some("run_lifecycle" | "snapshot_now")) => (Capability::Maintenance, true),
        ("tools/call", Some("consolidate")) => return Err(ServiceError::Forbidden),
        ("tools/call", Some(_)) => (Capability::Write, true),
        ("resources/list" | "resources/read" | "resources/templates/list", _) => {
            (Capability::Read, false)
        }
        ("resources/subscribe" | "resources/unsubscribe", _) => (Capability::Read, false),
        _ => (Capability::Read, false),
    };
    if !allows(principal.role, capability) {
        return Err(ServiceError::Forbidden);
    }
    if write {
        let writes = mcp_write_units(value).max(1);
        consume_write_quota(state, principal, writes)?;
    }
    if matches!(
        tool,
        Some("memory_delete" | "run_lifecycle" | "consolidate")
    ) {
        let arguments = value
            .get("params")
            .and_then(|params| params.get("arguments"));
        let resource_id = arguments
            .and_then(|arguments| arguments.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("tenant");
        let token = arguments
            .and_then(|arguments| arguments.get("confirmation_token"))
            .and_then(Value::as_str);
        let operation = tool.expect("matched maintenance tool");
        if !consume_confirmation(state, token, principal, operation, resource_id) {
            return Err(ServiceError::ConfirmationRequired {
                operation: operation.to_owned(),
                resource_id: resource_id.to_owned(),
            });
        }
    }
    Ok(())
}

fn is_mcp_read_tool(name: &str) -> bool {
    matches!(
        name,
        "recall"
            | "journal_recall"
            | "journal_verify_chain"
            | "memory_stats"
            | "memory_get"
            | "memory_list"
            | "entity_lookup"
            | "recall_at"
    )
}

fn mcp_request_mutates(value: &Value) -> bool {
    value.get("method").and_then(Value::as_str) == Some("tools/call")
        && value
            .get("params")
            .and_then(|params| params.get("name"))
            .and_then(Value::as_str)
            .is_some_and(|name| !is_mcp_read_tool(name) && name != "circadian_status")
}

fn mcp_write_units(value: &Value) -> u64 {
    if value
        .get("params")
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
        != Some("remember_batch")
    {
        return 1;
    }
    value
        .get("params")
        .and_then(|params| params.get("arguments"))
        .and_then(|arguments| arguments.get("items"))
        .and_then(Value::as_array)
        .map_or(1, |items| u64::try_from(items.len()).unwrap_or(u64::MAX))
}

fn mcp_update_changes_membership(value: &Value) -> bool {
    let patch = value
        .get("params")
        .and_then(|params| params.get("arguments"))
        .and_then(|arguments| arguments.get("patch"));
    patch.is_some_and(|patch| patch.get("state").is_some() || patch.get("scope").is_some())
}

fn inject_mcp_identity(message: &mut Value, principal: &Principal) {
    if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
        params.insert(
            "_authenticated_scope".to_owned(),
            json!({
                "tenant_id":principal.tenant_id.to_string(),
                "user_id":principal.user_id.to_string()
            }),
        );
        params.insert(
            "tenant_id".to_owned(),
            Value::String(principal.tenant_id.to_string()),
        );
        params.insert(
            "user_id".to_owned(),
            Value::String(principal.user_id.to_string()),
        );
        if let Some(uri) = params
            .get_mut("uri")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
        {
            params.insert(
                "uri".to_owned(),
                Value::String(canonical_resource_uri(&uri, principal)),
            );
        }
    }
    let Some(arguments) = message
        .get_mut("params")
        .and_then(|params| params.get_mut("arguments"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    arguments.insert(
        "tenant_id".to_owned(),
        Value::String(principal.tenant_id.to_string()),
    );
    arguments.insert(
        "user_id".to_owned(),
        Value::String(principal.user_id.to_string()),
    );
    if let Some(items) = arguments.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(item) = item.as_object_mut() {
                item.insert(
                    "tenant_id".to_owned(),
                    Value::String(principal.tenant_id.to_string()),
                );
                item.insert(
                    "user_id".to_owned(),
                    Value::String(principal.user_id.to_string()),
                );
            }
        }
    }
    arguments.insert(
        "agent_id".to_owned(),
        Value::String(principal.subject.clone()),
    );
    arguments.insert("actor".to_owned(), Value::String(principal.subject.clone()));
    arguments.remove("source_id");
    arguments.remove("source_uri");
    arguments
        .entry("scope".to_owned())
        .or_insert_with(|| Value::String("global".to_owned()));
    arguments.insert(
        "purpose".to_owned(),
        Value::String("conversational_context".to_owned()),
    );
    if arguments.get("source_kind").and_then(Value::as_str) == Some("system") {
        arguments.insert("source_kind".to_owned(), Value::String("user".to_owned()));
    }
    arguments.insert(
        "content_role".to_owned(),
        Value::String("observation".to_owned()),
    );
    if let Some(items) = arguments.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut().filter_map(Value::as_object_mut) {
            if item.get("source_kind").and_then(Value::as_str) == Some("system") {
                item.insert("source_kind".to_owned(), Value::String("user".to_owned()));
            }
            item.insert(
                "content_role".to_owned(),
                Value::String("observation".to_owned()),
            );
            item.insert(
                "agent_id".to_owned(),
                Value::String(principal.subject.clone()),
            );
            item.insert("actor".to_owned(), Value::String(principal.subject.clone()));
            item.remove("source_id");
            item.remove("source_uri");
            item.entry("scope".to_owned())
                .or_insert_with(|| Value::String("global".to_owned()));
            item.insert(
                "purpose".to_owned(),
                Value::String("conversational_context".to_owned()),
            );
        }
    }
    arguments.remove("_authenticated_scope");
    if let Err(error) = validate_mcp_operation_keys(arguments) {
        arguments.insert(
            "_invalid_operation_key".to_owned(),
            Value::String(error.to_owned()),
        );
        return;
    }
    if principal.role == Role::Auditor {
        arguments.insert(
            "disclosure_purpose".to_owned(),
            Value::String("safety_audit".to_owned()),
        );
    } else {
        arguments.insert(
            "disclosure_purpose".to_owned(),
            Value::String("conversational_context".to_owned()),
        );
    }
    arguments.insert(
        "disclosure_authority".to_owned(),
        Value::String(disclosure_authority_name(authority(principal.role)).to_owned()),
    );
}

fn disclosure_authority_name(authority: DisclosureAuthority) -> &'static str {
    match authority {
        DisclosureAuthority::Owner => "owner",
        DisclosureAuthority::Agent => "agent",
        DisclosureAuthority::Auditor => "auditor",
        DisclosureAuthority::ThirdParty => "third_party",
    }
}

fn validate_mcp_operation_keys(
    arguments: &serde_json::Map<String, Value>,
) -> Result<(), &'static str> {
    for field in ["idempotency_key", "source_event_id"] {
        if let Some(value) = arguments.get(field)
            && !value.as_str().is_some_and(valid_operation_key)
        {
            return Err(
                "operation keys must be 1..=255 bytes without surrounding whitespace or controls",
            );
        }
    }
    if let Some(items) = arguments.get("items").and_then(Value::as_array) {
        for item in items.iter().filter_map(Value::as_object) {
            if let Some(value) = item.get("idempotency_key")
                && !value.as_str().is_some_and(valid_operation_key)
            {
                return Err(
                    "operation keys must be 1..=255 bytes without surrounding whitespace or controls",
                );
            }
        }
    }
    Ok(())
}

fn valid_operation_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

async fn get_mcp(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if incompatible_mcp_version(request.headers()) {
        return error_response(
            ServiceError::InvalidRequest("unsupported MCP protocol version"),
            &request_id,
        );
    }
    if let Err(error) = consume_limit(&state, &principal, false) {
        return error_response(error, &request_id);
    }
    let accept = request
        .headers()
        .get(axum::http::header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !accept.contains("text/event-stream") {
        return error_response(ServiceError::NotAcceptable, &request_id);
    }
    let Some(session_id) = request
        .headers()
        .get(MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return error_response(
            ServiceError::InvalidRequest("missing MCP session"),
            &request_id,
        );
    };
    let mut sessions = state.mcp_sessions.lock().expect("mcp sessions");
    let Some(session) = sessions.get_mut(session_id) else {
        return error_response(ServiceError::NotFound, &request_id);
    };
    if session.principal != principal || session.expires_at < Instant::now() {
        return error_response(ServiceError::NotFound, &request_id);
    }
    if !session.initialized {
        return error_response(ServiceError::Conflict, &request_id);
    }
    if session.stream_active.swap(true, Ordering::AcqRel) {
        return error_response(ServiceError::Conflict, &request_id);
    }
    let stream_active = Arc::clone(&session.stream_active);
    let notification_dirty = Arc::clone(&session.notification_dirty);
    let notification_receiver = Arc::clone(&session.notification_receiver);
    let Some(receiver) = notification_receiver
        .lock()
        .expect("notification receiver")
        .take()
    else {
        session.stream_active.store(false, Ordering::Release);
        return error_response(ServiceError::Conflict, &request_id);
    };
    drop(sessions);
    let stream = SessionEventStream {
        inner: Some(ReceiverStream::new(receiver)),
        active: stream_active,
        return_to: notification_receiver,
        dirty: notification_dirty,
    };
    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keepalive"),
        )
        .into_response();
    insert_request_id(&mut response, &request_id);
    response
}

struct SessionEventStream {
    inner: Option<ReceiverStream<Value>>,
    active: Arc<AtomicBool>,
    return_to: Arc<Mutex<Option<mpsc::Receiver<Value>>>>,
    dirty: Arc<AtomicBool>,
}

impl Stream for SessionEventStream {
    type Item = Result<Event, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.dirty.swap(false, Ordering::AcqRel) {
            let event = Event::default()
                .json_data(json!({
                    "jsonrpc":"2.0","method":"notifications/resources/list_changed"
                }))
                .expect("static notification serializes");
            return Poll::Ready(Some(Ok(event)));
        }
        let Some(inner) = self.inner.as_mut() else {
            return Poll::Ready(None);
        };
        loop {
            match Pin::new(&mut *inner).poll_next(context) {
                Poll::Ready(Some(message)) => {
                    if let Ok(event) = Event::default().json_data(message) {
                        return Poll::Ready(Some(Ok(event)));
                    }
                }
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl Drop for SessionEventStream {
    fn drop(&mut self) {
        if let Some(receiver) = self.inner.take().map(ReceiverStream::into_inner) {
            *self.return_to.lock().expect("notification receiver") = Some(receiver);
        }
        self.active.store(false, Ordering::Release);
    }
}

async fn delete_mcp(State(state): State<AppState>, request: Request) -> Response {
    let request_id = request_id(request.headers());
    let principal = match authenticate(&state, request.headers()) {
        Ok(principal) => principal,
        Err(error) => return error_response(error, &request_id),
    };
    if incompatible_mcp_version(request.headers()) {
        return error_response(
            ServiceError::InvalidRequest("unsupported MCP protocol version"),
            &request_id,
        );
    }
    if let Err(error) = consume_limit(&state, &principal, false) {
        return error_response(error, &request_id);
    }
    let Some(session_id) = request
        .headers()
        .get(MCP_SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return error_response(
            ServiceError::InvalidRequest("missing MCP session"),
            &request_id,
        );
    };
    let mut sessions = state.mcp_sessions.lock().expect("mcp sessions");
    if sessions
        .get(session_id)
        .is_none_or(|session| session.principal != principal)
    {
        return error_response(ServiceError::NotFound, &request_id);
    }
    sessions.remove(session_id);
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    insert_request_id(&mut response, &request_id);
    response
}

fn incompatible_mcp_version(headers: &HeaderMap) -> bool {
    headers
        .get(MCP_VERSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|version| version != MCP_PROTOCOL)
}

#[derive(Clone, Debug, Error)]
enum ServiceError {
    #[error("invalid request")]
    InvalidRequest(&'static str),
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("revision conflict")]
    Conflict,
    #[error("confirmation required")]
    ConfirmationRequired {
        operation: String,
        resource_id: String,
    },
    #[error("rate limited")]
    RateLimited,
    #[error("quota exceeded")]
    QuotaExceeded,
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("unsupported media type")]
    UnsupportedMediaType,
    #[error("not acceptable")]
    NotAcceptable,
    #[error("unavailable")]
    Unavailable,
    #[error("invalid checkpoint")]
    InvalidCheckpoint,
    #[error("internal error")]
    Internal,
}

impl ServiceError {
    fn from_engine(error: MemoryEngineError) -> Self {
        match error {
            MemoryEngineError::RevisionConflict { .. }
            | MemoryEngineError::IdempotencyConflict
            | MemoryEngineError::IngestionConflict { .. }
            | MemoryEngineError::ConsolidationPlanConflict => Self::Conflict,
            MemoryEngineError::TenantMismatch { .. } => Self::Internal,
            MemoryEngineError::Quantize(_) | MemoryEngineError::EmbeddingSpaceMismatch { .. } => {
                Self::InvalidRequest("invalid embedding")
            }
            MemoryEngineError::EthicsBlocked { .. } => Self::InvalidRequest("ethics blocked"),
            MemoryEngineError::EmptyPatch => Self::InvalidRequest("empty patch"),
            MemoryEngineError::InvalidRecallRequest { .. }
            | MemoryEngineError::Filter(_)
            | MemoryEngineError::InvalidClaim(_)
            | MemoryEngineError::InvalidGraph(_)
            | MemoryEngineError::InvalidDerived(_) => Self::InvalidRequest("invalid request"),
            _ => Self::Internal,
        }
    }

    fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "invalid_request",
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden => "forbidden",
            Self::NotFound => "resource_not_found",
            Self::Conflict => "conflict",
            Self::ConfirmationRequired { .. } => "confirmation_required",
            Self::RateLimited => "rate_limited",
            Self::QuotaExceeded => "quota_exceeded",
            Self::PayloadTooLarge => "payload_too_large",
            Self::UnsupportedMediaType => "unsupported_media_type",
            Self::NotAcceptable => "not_acceptable",
            Self::Unavailable => "storage_unavailable",
            Self::InvalidCheckpoint => "checkpoint_integrity_failed",
            Self::Internal => "internal_error",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthenticated => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict => StatusCode::CONFLICT,
            Self::ConfirmationRequired { .. } => StatusCode::ACCEPTED,
            Self::RateLimited | Self::QuotaExceeded => StatusCode::TOO_MANY_REQUESTS,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::NotAcceptable => StatusCode::NOT_ACCEPTABLE,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::InvalidCheckpoint => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

fn error_response(error: ServiceError, request_id: &str) -> Response {
    let details = match &error {
        ServiceError::ConfirmationRequired {
            operation,
            resource_id,
        } => json!({"operation":operation,"resource_id":resource_id}),
        _ => Value::Null,
    };
    let mut response = json_response(
        error.status(),
        json!({"error":{"code":error.code(),"message":error.to_string(),"request_id":request_id,"details":details}}),
        Some(request_id),
    );
    if matches!(error, ServiceError::Unauthenticated) {
        let challenge = "Bearer";
        response.headers_mut().insert(
            axum::http::header::WWW_AUTHENTICATE,
            HeaderValue::from_static(challenge),
        );
    }
    response
}

fn json_response(status: StatusCode, value: Value, request_id: Option<&str>) -> Response {
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Some(request_id) = request_id {
        insert_request_id(&mut response, request_id);
    }
    response
}

fn request_id(headers: &HeaderMap) -> String {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        })
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::now_v7().to_string())
}

fn insert_request_id(response: &mut Response, request_id: &str) {
    if let Ok(value) = HeaderValue::from_str(request_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static(REQUEST_ID_HEADER), value);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn openapi_document() -> Value {
    json!({
        "openapi":"3.1.0",
        "info":{"title":"Celiums Memory API","version":env!("CARGO_PKG_VERSION")},
        "components":{
            "securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"}},
            "schemas":{
                "Error":{"type":"object","required":["error"],"properties":{"error":{"type":"object","required":["code","message","request_id"],"properties":{"code":{"type":"string"},"message":{"type":"string"},"request_id":{"type":"string"}}}}},
                "RememberRequest":{"type":"object","required":["content"],"properties":{"content":{"type":"string","maxLength":65536},"scope":{"type":"string","enum":["global","project","session"]},"project_id":{"type":"string"},"conversation_id":{"type":"string"},"session_id":{"type":"string"},"idempotency_key":{"type":"string","minLength":1,"pattern":"^\\S(?:[^\\u0000-\\u001f\\u007f]*\\S)?$","description":"1..=255 UTF-8 bytes, no surrounding whitespace or control characters"}}},
                "ConfirmationRequest":{"type":"object","required":["operation","resource_id"],"properties":{"operation":{"type":"string","enum":["memory_delete","run_lifecycle"]},"resource_id":{"type":"string","minLength":1,"maxLength":255}}},
                "ConfirmationResponse":{"type":"object","required":["token","expires_at_ms"],"properties":{"token":{"type":"string"},"expires_at_ms":{"type":"integer"}}},
                "McpMessage":{"type":"object","required":["jsonrpc","method"],"properties":{"jsonrpc":{"const":"2.0"},"id":{},"method":{"type":"string"},"params":{"type":"object"}}},
                "UpdateRequest":{"type":"object","required":["if_revision"],"properties":{"if_revision":{"type":"integer","minimum":1},"importance":{"type":"number","minimum":0,"maximum":1},"tags":{"type":"array","items":{"type":"string"}}}},
                "RecallRequest":{"type":"object","required":["query"],"properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}}}
            }
        },
        "paths":{
            "/healthz":{"get":{"responses":{"200":{"description":"live"}}}},
            "/readyz":{"get":{"responses":{"200":{"description":"ready"}}}},
            "/version":{"get":{"responses":{"200":{"description":"version"}}}},
            "/mcp":{"post":{"security":[{"bearerAuth":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/McpMessage"}}}},"responses":{"200":{"description":"MCP JSON-RPC"},"202":{"description":"notification accepted"},"400":{"description":"invalid MCP message"},"406":{"description":"invalid Accept"}}},"get":{"security":[{"bearerAuth":[]}],"responses":{"200":{"description":"MCP SSE"}}},"delete":{"security":[{"bearerAuth":[]}],"responses":{"204":{"description":"session terminated"}}}},
            "/v1/memories":{"post":{"security":[{"bearerAuth":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/RememberRequest"}}}},"responses":{"200":{"description":"remember"},"400":{"description":"invalid","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}}}},"get":{"security":[{"bearerAuth":[]}],"responses":{"200":{"description":"list"}}}},
            "/v1/memories/{id}":{
                "parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}],
                "get":{"security":[{"bearerAuth":[]}],"responses":{"200":{"description":"get"},"404":{"description":"not found"}}},
                "patch":{"security":[{"bearerAuth":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/UpdateRequest"}}}},"responses":{"200":{"description":"update"},"400":{"description":"invalid","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}},"409":{"description":"revision conflict"},"404":{"description":"not found"}}},
                "delete":{"security":[{"bearerAuth":[]}],"parameters":[{"name":"X-Celiums-Confirmation","in":"header","required":true,"schema":{"type":"string"}}],"responses":{"200":{"description":"delete"},"202":{"description":"confirmation required"}}}
            },
            "/v1/recall":{"post":{"security":[{"bearerAuth":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/RecallRequest"}}}},"responses":{"200":{"description":"recall"}}}},
            "/v1/confirmations":{"post":{"security":[{"bearerAuth":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/ConfirmationRequest"}}}},"responses":{"201":{"description":"confirmation token","content":{"application/json":{"schema":{"$ref":"#/components/schemas/ConfirmationResponse"}}}},"400":{"description":"invalid","content":{"application/json":{"schema":{"$ref":"#/components/schemas/Error"}}}}}}}
        }
    })
}

/// Parses a compact static API-key map.
pub fn parse_api_keys(value: &str) -> Result<BTreeMap<String, Principal>, String> {
    let mut keys = BTreeMap::new();
    for entry in value.split(',').filter(|entry| !entry.trim().is_empty()) {
        let parts = entry.split(':').collect::<Vec<_>>();
        if parts.len() != 5 {
            return Err("API keys require token:tenant:user:subject:role".to_owned());
        }
        let role = match parts[4] {
            "reader" => Role::Reader,
            "writer" => Role::Writer,
            "maintainer" => Role::Maintainer,
            "auditor" => Role::Auditor,
            "owner" => Role::Owner,
            _ => return Err("invalid API key role".to_owned()),
        };
        keys.insert(
            parts[0].to_owned(),
            Principal {
                tenant_id: TenantId::new(parts[1]).map_err(|error| error.to_string())?,
                user_id: UserId::new(parts[2]).map_err(|error| error.to_string())?,
                subject: parts[3].to_owned(),
                role,
            },
        );
    }
    Ok(keys)
}
