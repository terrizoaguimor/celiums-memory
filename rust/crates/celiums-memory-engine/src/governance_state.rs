// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable codec for one memory's governance classification.

use std::collections::BTreeMap;

use celiums_cognition::{
    ContentRole, DisclosureClass, EnforcementDecision, GovernanceClassification, GovernanceTrace,
    MemoryPurpose, PiiKind, PoisoningRisk, RedactionCategory, RedactionSpan, SecretKind,
    Sensitivity, Treatment, TrustLevel,
};
use hyphae_query::Value;

use crate::MemoryDecodeError;

/// Governance state embedded in each durable memory record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryGovernance(pub GovernanceClassification);

impl MemoryGovernance {
    pub(crate) fn to_value(&self) -> Value {
        let classification = &self.0;
        Value::Object(BTreeMap::from([
            ("role".to_owned(), string(role_str(classification.role))),
            (
                "purpose".to_owned(),
                string(purpose_str(classification.purpose)),
            ),
            ("trust".to_owned(), string(trust_str(classification.trust))),
            (
                "sensitivity".to_owned(),
                string(sensitivity_str(classification.sensitivity)),
            ),
            (
                "poisoning_risk".to_owned(),
                string(poisoning_str(classification.poisoning_risk)),
            ),
            (
                "treatment".to_owned(),
                string(treatment_str(classification.treatment)),
            ),
            (
                "enforcement".to_owned(),
                string(enforcement_str(classification.enforcement)),
            ),
            (
                "disclosure".to_owned(),
                string(disclosure_str(classification.disclosure)),
            ),
            ("trace".to_owned(), trace_value(&classification.trace)),
        ]))
    }

    pub(crate) fn from_value(value: &Value) -> Result<Self, MemoryDecodeError> {
        let Value::Object(fields) = value else {
            return field_error("governance");
        };
        Ok(Self(GovernanceClassification {
            role: parse_role(&text(fields, "role")?).ok_or_field("governance.role")?,
            purpose: parse_purpose(&text(fields, "purpose")?).ok_or_field("governance.purpose")?,
            trust: parse_trust(&text(fields, "trust")?).ok_or_field("governance.trust")?,
            sensitivity: parse_sensitivity(&text(fields, "sensitivity")?)
                .ok_or_field("governance.sensitivity")?,
            poisoning_risk: parse_poisoning(&text(fields, "poisoning_risk")?)
                .ok_or_field("governance.poisoning")?,
            treatment: parse_treatment(&text(fields, "treatment")?)
                .ok_or_field("governance.treatment")?,
            enforcement: parse_enforcement(&text(fields, "enforcement")?)
                .ok_or_field("governance.enforcement")?,
            disclosure: parse_disclosure(&text(fields, "disclosure")?)
                .ok_or_field("governance.disclosure")?,
            trace: parse_trace(fields.get("trace").ok_or_field("governance.trace")?)?,
        }))
    }
}

fn trace_value(trace: &GovernanceTrace) -> Value {
    Value::Object(BTreeMap::from([
        ("policy_id".to_owned(), string(&trace.policy_id)),
        ("policy_version".to_owned(), string(&trace.policy_version)),
        ("policy_hash".to_owned(), string(&trace.policy_hash)),
        (
            "evaluated_at_ms".to_owned(),
            Value::Integer(trace.evaluated_at_ms),
        ),
        (
            "ethics_enforcement_blocked".to_owned(),
            Value::Integer(i64::from(trace.ethics_enforcement_blocked)),
        ),
        (
            "pii".to_owned(),
            Value::Array(
                trace
                    .pii
                    .iter()
                    .map(|kind| string(pii_str(*kind)))
                    .collect(),
            ),
        ),
        (
            "secrets".to_owned(),
            Value::Array(
                trace
                    .secrets
                    .iter()
                    .map(|kind| string(secret_str(*kind)))
                    .collect(),
            ),
        ),
        (
            "redaction_spans".to_owned(),
            Value::Array(trace.redaction_spans.iter().map(span_value).collect()),
        ),
    ]))
}

fn parse_trace(value: &Value) -> Result<GovernanceTrace, MemoryDecodeError> {
    let Value::Object(fields) = value else {
        return field_error("governance.trace");
    };
    Ok(GovernanceTrace {
        policy_id: text(fields, "policy_id")?,
        policy_version: text(fields, "policy_version")?,
        policy_hash: text(fields, "policy_hash")?,
        evaluated_at_ms: integer(fields, "evaluated_at_ms")?,
        ethics_enforcement_blocked: boolean(fields, "ethics_enforcement_blocked")?,
        pii: string_array(fields, "pii")?
            .into_iter()
            .map(|value| parse_pii(&value).ok_or_field("governance.pii"))
            .collect::<Result<_, _>>()?,
        secrets: string_array(fields, "secrets")?
            .into_iter()
            .map(|value| parse_secret(&value).ok_or_field("governance.secrets"))
            .collect::<Result<_, _>>()?,
        redaction_spans: spans(fields)?,
    })
}

fn span_value(span: &RedactionSpan) -> Value {
    let (kind, category) = match span.category {
        RedactionCategory::Pii(kind) => ("pii", pii_str(kind)),
        RedactionCategory::Secret(kind) => ("secret", secret_str(kind)),
    };
    Value::Object(BTreeMap::from([
        ("start".to_owned(), Value::Integer(span.start as i64)),
        ("end".to_owned(), Value::Integer(span.end as i64)),
        ("kind".to_owned(), string(kind)),
        ("category".to_owned(), string(category)),
        ("replacement".to_owned(), string(&span.replacement)),
    ]))
}

fn spans(fields: &BTreeMap<String, Value>) -> Result<Vec<RedactionSpan>, MemoryDecodeError> {
    let Some(Value::Array(values)) = fields.get("redaction_spans") else {
        return field_error("governance.redaction_spans");
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(span) = value else {
                return field_error("governance.redaction_span");
            };
            let category_name = text(span, "category")?;
            let category = match text(span, "kind")?.as_str() {
                "pii" => RedactionCategory::Pii(
                    parse_pii(&category_name).ok_or_field("governance.redaction_span")?,
                ),
                "secret" => RedactionCategory::Secret(
                    parse_secret(&category_name).ok_or_field("governance.redaction_span")?,
                ),
                _ => return field_error("governance.redaction_span"),
            };
            Ok(RedactionSpan {
                start: integer(span, "start")?.try_into().map_err(|_| {
                    MemoryDecodeError::Field {
                        field: "governance.redaction_span",
                    }
                })?,
                end: integer(span, "end")?
                    .try_into()
                    .map_err(|_| MemoryDecodeError::Field {
                        field: "governance.redaction_span",
                    })?,
                category,
                replacement: text(span, "replacement")?,
            })
        })
        .collect()
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}
fn text(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<String, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::String(value)) => Ok(value.clone()),
        _ => field_error(field),
    }
}
fn integer(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<i64, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(value)) => Ok(*value),
        _ => field_error(field),
    }
}
fn boolean(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<bool, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Integer(0)) => Ok(false),
        Some(Value::Integer(1)) => Ok(true),
        _ => field_error(field),
    }
}
fn string_array(
    fields: &BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Vec<String>, MemoryDecodeError> {
    match fields.get(field) {
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| match value {
                Value::String(value) => Ok(value.clone()),
                _ => field_error(field),
            })
            .collect(),
        _ => field_error(field),
    }
}
fn field_error<T>(field: &'static str) -> Result<T, MemoryDecodeError> {
    Err(MemoryDecodeError::Field { field })
}
trait OptionField<T> {
    fn ok_or_field(self, field: &'static str) -> Result<T, MemoryDecodeError>;
}
impl<T> OptionField<T> for Option<T> {
    fn ok_or_field(self, field: &'static str) -> Result<T, MemoryDecodeError> {
        self.ok_or(MemoryDecodeError::Field { field })
    }
}

macro_rules! enum_codec { ($to:ident, $parse:ident, $ty:ty, {$($variant:path => $name:literal),+ $(,)?}) => {
    fn $to(value: $ty) -> &'static str { match value { $($variant => $name),+ } }
    fn $parse(value: &str) -> Option<$ty> { match value { $($name => Some($variant)),+, _ => None } }
}; }
enum_codec!(role_str, parse_role, ContentRole, {ContentRole::Observation=>"observation",ContentRole::Description=>"description",ContentRole::OperationalRequest=>"operational_request"});
enum_codec!(purpose_str, parse_purpose, MemoryPurpose, {MemoryPurpose::ConversationalContext=>"conversational_context",MemoryPurpose::Personalization=>"personalization",MemoryPurpose::TaskExecution=>"task_execution",MemoryPurpose::SafetyAudit=>"safety_audit"});
enum_codec!(trust_str, parse_trust, TrustLevel, {TrustLevel::Trusted=>"trusted",TrustLevel::UserProvided=>"user_provided",TrustLevel::Untrusted=>"untrusted"});
enum_codec!(sensitivity_str, parse_sensitivity, Sensitivity, {Sensitivity::None=>"none",Sensitivity::Personal=>"personal",Sensitivity::HighlySensitive=>"highly_sensitive",Sensitivity::Secret=>"secret"});
enum_codec!(poisoning_str, parse_poisoning, PoisoningRisk, {PoisoningRisk::None=>"none",PoisoningRisk::SuspiciousInstruction=>"suspicious_instruction",PoisoningRisk::PersistentInstruction=>"persistent_instruction"});
enum_codec!(treatment_str, parse_treatment, Treatment, {Treatment::Normal=>"normal",Treatment::Sensitive=>"sensitive",Treatment::Restricted=>"restricted",Treatment::Quarantined=>"quarantined"});
enum_codec!(enforcement_str, parse_enforcement, EnforcementDecision, {EnforcementDecision::Allow=>"allow",EnforcementDecision::AllowRestricted=>"allow_restricted",EnforcementDecision::Reject=>"reject",EnforcementDecision::Quarantine=>"quarantine"});
enum_codec!(disclosure_str, parse_disclosure, DisclosureClass, {DisclosureClass::Include=>"include",DisclosureClass::Summarize=>"summarize",DisclosureClass::Redact=>"redact",DisclosureClass::Restrict=>"restrict",DisclosureClass::Abstain=>"abstain"});
enum_codec!(pii_str, parse_pii, PiiKind, {PiiKind::EmailAddress=>"email",PiiKind::PhoneNumber=>"phone",PiiKind::SocialSecurityNumber=>"ssn",PiiKind::PaymentCard=>"payment_card"});
enum_codec!(secret_str, parse_secret, SecretKind, {SecretKind::AwsAccessKey=>"aws_access_key",SecretKind::BearerToken=>"bearer_token",SecretKind::PrivateKey=>"private_key",SecretKind::ApiKey=>"api_key",SecretKind::Password=>"password"});
