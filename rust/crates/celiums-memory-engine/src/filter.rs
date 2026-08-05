// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Canonical, transport-independent filters for durable memories.

use std::fmt;

use hyphae_query::{CompareOperator, FieldPath, Filter, Value};

use crate::RecallScope;

const MAX_FILTER_NODES: usize = 64;
const MAX_FILTER_DEPTH: usize = 8;
const MAX_LIST_VALUES: usize = 50;
const NANOS: f64 = 1_000_000_000.0;
const I64_UPPER_EXCLUSIVE_AS_F64: f64 = 9_223_372_036_854_775_808.0;

/// A closed Boolean expression over the public memory fields.
#[derive(Clone, Debug, PartialEq)]
pub enum MemoryFilter {
    /// Matches every memory visible to the caller.
    MatchAll,
    /// Requires every child expression to match.
    All(Vec<Self>),
    /// Requires at least one child expression to match.
    Any(Vec<Self>),
    /// Negates one expression.
    Not(Box<Self>),
    /// Applies one typed predicate.
    Predicate(MemoryPredicate),
}

/// One field/operator/value condition.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryPredicate {
    /// Memory field being tested.
    pub field: MemoryField,
    /// Operation applied to the field.
    pub operator: FilterOperator,
    /// Typed operand, absent only for null tests.
    pub value: Option<FilterValue>,
}

/// Public P1 fields that may participate in a memory filter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryField {
    /// Agent identity.
    AgentId,
    /// Project identity.
    ProjectId,
    /// Conversation identity.
    ConversationId,
    /// Session identity.
    SessionId,
    /// Visibility scope.
    Scope,
    /// Memory classification.
    MemoryType,
    /// Lifecycle state.
    State,
    /// Importance scalar.
    Importance,
    /// Ebbinghaus strength scalar.
    Strength,
    /// Successful recall count.
    RetrievalCount,
    /// Consolidation count.
    ConsolidationCount,
    /// PAD valence scalar.
    Valence,
    /// PAD arousal scalar.
    Arousal,
    /// PAD dominance scalar.
    Dominance,
    /// Free-form tag array.
    Tags,
    /// Creation timestamp in Unix milliseconds.
    CreatedAt,
    /// Optional source event timestamp in Unix milliseconds.
    EventAt,
    /// Ingestion timestamp in Unix milliseconds.
    IngestedAt,
    /// Last successful recall timestamp in Unix milliseconds.
    LastRetrievedAt,
    /// Provenance source class.
    SourceKind,
    /// Optional upstream source identifier.
    SourceId,
    /// Optional source URI.
    SourceUri,
    /// Optional source actor or speaker.
    SourceActor,
    /// BLAKE3 content digest.
    ContentHash,
}

/// Operations supported by the canonical filter algebra.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FilterOperator {
    /// Exact equality.
    Eq,
    /// Exact inequality.
    Ne,
    /// Less than.
    Lt,
    /// Less than or equal.
    Lte,
    /// Greater than.
    Gt,
    /// Greater than or equal.
    Gte,
    /// Equal to any value in a list.
    In,
    /// Equal to no value in a list.
    NotIn,
    /// String prefix.
    Prefix,
    /// String substring or tag membership.
    Contains,
    /// Explicit null.
    IsNull,
    /// Present and not null.
    IsNotNull,
    /// Inclusive numeric or timestamp range.
    Between,
}

/// Typed literal accepted by a memory predicate.
#[derive(Clone, Debug, PartialEq)]
pub enum FilterValue {
    /// One UTF-8 string.
    String(String),
    /// One integer.
    Integer(i64),
    /// One floating-point scalar.
    Float(f64),
    /// A list of UTF-8 strings.
    Strings(Vec<String>),
    /// A list of integers.
    Integers(Vec<i64>),
    /// A list of floating-point scalars.
    Floats(Vec<f64>),
}

/// A filter rejected before it reaches the storage query engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemoryFilterError {
    /// The expression contains too many nodes.
    TooManyNodes {
        /// Observed node count.
        actual: usize,
        /// Maximum accepted node count.
        maximum: usize,
    },
    /// The expression is nested too deeply.
    TooDeep {
        /// Observed depth, counting the root as one.
        actual: usize,
        /// Maximum accepted depth.
        maximum: usize,
    },
    /// A list exceeds its element budget.
    TooManyValues {
        /// Observed list length.
        actual: usize,
        /// Maximum accepted list length.
        maximum: usize,
    },
    /// The operator is not available for the selected field.
    InvalidOperator {
        /// Selected field.
        field: MemoryField,
        /// Rejected operator.
        operator: FilterOperator,
    },
    /// The operator requires a value but none was supplied.
    MissingValue {
        /// Operator requiring a value.
        operator: FilterOperator,
    },
    /// A null test incorrectly supplied a value.
    UnexpectedValue {
        /// Null operator that received a value.
        operator: FilterOperator,
    },
    /// The value variant does not match the field and operator.
    InvalidValue {
        /// Selected field.
        field: MemoryField,
        /// Selected operator.
        operator: FilterOperator,
    },
    /// Membership requires at least one candidate.
    EmptyList,
    /// A range requires exactly two endpoints.
    InvalidRangeLength {
        /// Observed endpoint count.
        actual: usize,
    },
    /// A floating-point operand is NaN or infinite.
    NonFiniteFloat,
    /// A floating-point operand cannot be represented as integer nanos.
    FloatOutOfRange,
}

impl fmt::Display for MemoryFilterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyNodes { actual, maximum } => {
                write!(formatter, "filter has {actual} nodes; maximum is {maximum}")
            }
            Self::TooDeep { actual, maximum } => {
                write!(formatter, "filter depth is {actual}; maximum is {maximum}")
            }
            Self::TooManyValues { actual, maximum } => {
                write!(
                    formatter,
                    "filter list has {actual} values; maximum is {maximum}"
                )
            }
            Self::InvalidOperator { field, operator } => {
                write!(
                    formatter,
                    "operator {operator:?} is invalid for field {field:?}"
                )
            }
            Self::MissingValue { operator } => {
                write!(formatter, "operator {operator:?} requires a value")
            }
            Self::UnexpectedValue { operator } => {
                write!(formatter, "operator {operator:?} does not accept a value")
            }
            Self::InvalidValue { field, operator } => write!(
                formatter,
                "value is invalid for operator {operator:?} on field {field:?}"
            ),
            Self::EmptyList => formatter.write_str("membership list must not be empty"),
            Self::InvalidRangeLength { actual } => {
                write!(
                    formatter,
                    "range has {actual} endpoints; exactly two are required"
                )
            }
            Self::NonFiniteFloat => formatter.write_str("filter floats must be finite"),
            Self::FloatOutOfRange => {
                formatter.write_str("filter float cannot be represented as integer nanos")
            }
        }
    }
}

impl std::error::Error for MemoryFilterError {}

impl MemoryFilter {
    /// Validates expression budgets and the complete field/operator/value matrix.
    ///
    /// # Errors
    ///
    /// Returns a precise validation error for the first invalid component.
    pub fn validate(&self) -> Result<(), MemoryFilterError> {
        let mut nodes = 0_usize;
        let mut maximum_depth = 0_usize;
        let mut pending = vec![(self, 1_usize)];

        while let Some((filter, depth)) = pending.pop() {
            nodes = nodes.saturating_add(1);
            maximum_depth = maximum_depth.max(depth);
            match filter {
                Self::All(children) | Self::Any(children) => pending.extend(
                    children
                        .iter()
                        .map(|child| (child, depth.saturating_add(1))),
                ),
                Self::Not(child) => pending.push((child, depth.saturating_add(1))),
                Self::Predicate(predicate) => predicate.validate()?,
                Self::MatchAll => {}
            }
        }

        if nodes > MAX_FILTER_NODES {
            return Err(MemoryFilterError::TooManyNodes {
                actual: nodes,
                maximum: MAX_FILTER_NODES,
            });
        }
        if maximum_depth > MAX_FILTER_DEPTH {
            return Err(MemoryFilterError::TooDeep {
                actual: maximum_depth,
                maximum: MAX_FILTER_DEPTH,
            });
        }
        Ok(())
    }

    /// Validates and compiles this expression to the Hyphae query model.
    ///
    /// # Errors
    ///
    /// Returns an error when the expression is structurally or semantically invalid.
    pub fn compile(&self) -> Result<Filter, MemoryFilterError> {
        self.validate()?;
        Ok(compile_valid_filter(self))
    }
}

impl MemoryPredicate {
    fn validate(&self) -> Result<(), MemoryFilterError> {
        if !self.field.supports(self.operator) {
            return Err(MemoryFilterError::InvalidOperator {
                field: self.field,
                operator: self.operator,
            });
        }

        if matches!(
            self.operator,
            FilterOperator::IsNull | FilterOperator::IsNotNull
        ) {
            return if self.value.is_none() {
                Ok(())
            } else {
                Err(MemoryFilterError::UnexpectedValue {
                    operator: self.operator,
                })
            };
        }

        let value = self.value.as_ref().ok_or(MemoryFilterError::MissingValue {
            operator: self.operator,
        })?;
        validate_value(self.field, self.operator, value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FieldKind {
    Text,
    Category,
    Float,
    Integer,
    Tags,
}

impl MemoryField {
    fn path(self) -> FieldPath {
        FieldPath::field(match self {
            Self::AgentId => "agent_id",
            Self::ProjectId => "project_id",
            Self::ConversationId => "conversation_id",
            Self::SessionId => "session_id",
            Self::Scope => "scope",
            Self::MemoryType => "memory_type",
            Self::State => "state",
            Self::Importance => "importance",
            Self::Strength => "strength",
            Self::RetrievalCount => "retrieval_count",
            Self::ConsolidationCount => "consolidation_count",
            Self::Valence => "valence",
            Self::Arousal => "arousal",
            Self::Dominance => "dominance",
            Self::Tags => "tags",
            Self::CreatedAt => "created_at_ms",
            Self::EventAt => "event_at_ms",
            Self::IngestedAt => "ingested_at_ms",
            Self::LastRetrievedAt => "last_retrieved_at_ms",
            Self::SourceKind => "source_kind",
            Self::SourceId => "source_id",
            Self::SourceUri => "source_uri",
            Self::SourceActor => "source_actor",
            Self::ContentHash => "content_hash",
        })
    }

    fn kind(self) -> FieldKind {
        match self {
            Self::AgentId
            | Self::ProjectId
            | Self::ConversationId
            | Self::SessionId
            | Self::SourceId
            | Self::SourceUri
            | Self::SourceActor
            | Self::ContentHash => FieldKind::Text,
            Self::Scope | Self::MemoryType | Self::State | Self::SourceKind => FieldKind::Category,
            Self::Importance | Self::Strength | Self::Valence | Self::Arousal | Self::Dominance => {
                FieldKind::Float
            }
            Self::RetrievalCount
            | Self::ConsolidationCount
            | Self::CreatedAt
            | Self::EventAt
            | Self::IngestedAt
            | Self::LastRetrievedAt => FieldKind::Integer,
            Self::Tags => FieldKind::Tags,
        }
    }

    fn nullable(self) -> bool {
        matches!(
            self,
            Self::AgentId
                | Self::ProjectId
                | Self::ConversationId
                | Self::SessionId
                | Self::EventAt
                | Self::SourceId
                | Self::SourceUri
                | Self::SourceActor
        )
    }

    fn supports(self, operator: FilterOperator) -> bool {
        use FilterOperator as Op;

        match operator {
            Op::IsNull | Op::IsNotNull => self.nullable(),
            Op::Eq | Op::Ne | Op::In | Op::NotIn => !matches!(self.kind(), FieldKind::Tags),
            Op::Lt | Op::Lte | Op::Gt | Op::Gte | Op::Between => {
                matches!(self.kind(), FieldKind::Float | FieldKind::Integer)
            }
            Op::Prefix => matches!(self.kind(), FieldKind::Text),
            Op::Contains => matches!(self.kind(), FieldKind::Text | FieldKind::Tags),
        }
    }
}

fn validate_value(
    field: MemoryField,
    operator: FilterOperator,
    value: &FilterValue,
) -> Result<(), MemoryFilterError> {
    use FilterOperator as Op;

    match operator {
        Op::Eq | Op::Ne | Op::Lt | Op::Lte | Op::Gt | Op::Gte | Op::Prefix | Op::Contains => {
            validate_scalar(field, operator, value)
        }
        Op::In | Op::NotIn => validate_membership(field, operator, value),
        Op::Between => validate_range(field, operator, value),
        Op::IsNull | Op::IsNotNull => unreachable!("null values are validated separately"),
    }
}

fn validate_scalar(
    field: MemoryField,
    operator: FilterOperator,
    value: &FilterValue,
) -> Result<(), MemoryFilterError> {
    let valid = match field.kind() {
        FieldKind::Text | FieldKind::Category | FieldKind::Tags => {
            matches!(value, FilterValue::String(_))
        }
        FieldKind::Integer => matches!(value, FilterValue::Integer(_)),
        FieldKind::Float => matches!(value, FilterValue::Float(_)),
    };
    if !valid {
        return Err(MemoryFilterError::InvalidValue { field, operator });
    }
    validate_floats(value)
}

fn validate_membership(
    field: MemoryField,
    operator: FilterOperator,
    value: &FilterValue,
) -> Result<(), MemoryFilterError> {
    let length = list_length(value).ok_or(MemoryFilterError::InvalidValue { field, operator })?;
    if length == 0 {
        return Err(MemoryFilterError::EmptyList);
    }
    validate_list_budget(length)?;

    let valid = match field.kind() {
        FieldKind::Text | FieldKind::Category => matches!(value, FilterValue::Strings(_)),
        FieldKind::Integer => matches!(value, FilterValue::Integers(_)),
        FieldKind::Float => matches!(value, FilterValue::Floats(_)),
        FieldKind::Tags => false,
    };
    if !valid {
        return Err(MemoryFilterError::InvalidValue { field, operator });
    }
    validate_floats(value)
}

fn validate_range(
    field: MemoryField,
    operator: FilterOperator,
    value: &FilterValue,
) -> Result<(), MemoryFilterError> {
    let length = list_length(value).ok_or(MemoryFilterError::InvalidValue { field, operator })?;
    if length != 2 {
        return Err(MemoryFilterError::InvalidRangeLength { actual: length });
    }
    let valid = match field.kind() {
        FieldKind::Integer => matches!(value, FilterValue::Integers(_)),
        FieldKind::Float => matches!(value, FilterValue::Floats(_)),
        FieldKind::Text | FieldKind::Category | FieldKind::Tags => false,
    };
    if !valid {
        return Err(MemoryFilterError::InvalidValue { field, operator });
    }
    validate_floats(value)
}

fn list_length(value: &FilterValue) -> Option<usize> {
    match value {
        FilterValue::Strings(values) => Some(values.len()),
        FilterValue::Integers(values) => Some(values.len()),
        FilterValue::Floats(values) => Some(values.len()),
        FilterValue::String(_) | FilterValue::Integer(_) | FilterValue::Float(_) => None,
    }
}

fn validate_list_budget(length: usize) -> Result<(), MemoryFilterError> {
    if length > MAX_LIST_VALUES {
        return Err(MemoryFilterError::TooManyValues {
            actual: length,
            maximum: MAX_LIST_VALUES,
        });
    }
    Ok(())
}

fn validate_floats(value: &FilterValue) -> Result<(), MemoryFilterError> {
    let values: &[f64] = match value {
        FilterValue::Float(value) => std::slice::from_ref(value),
        FilterValue::Floats(values) => values,
        FilterValue::String(_)
        | FilterValue::Integer(_)
        | FilterValue::Strings(_)
        | FilterValue::Integers(_) => return Ok(()),
    };

    for value in values {
        if !value.is_finite() {
            return Err(MemoryFilterError::NonFiniteFloat);
        }
        let nanos = value * NANOS;
        if nanos < i64::MIN as f64 || nanos >= I64_UPPER_EXCLUSIVE_AS_F64 {
            return Err(MemoryFilterError::FloatOutOfRange);
        }
    }
    Ok(())
}

fn compile_valid_filter(filter: &MemoryFilter) -> Filter {
    match filter {
        MemoryFilter::MatchAll => Filter::MatchAll,
        MemoryFilter::All(children) => {
            Filter::All(children.iter().map(compile_valid_filter).collect())
        }
        MemoryFilter::Any(children) => {
            Filter::Any(children.iter().map(compile_valid_filter).collect())
        }
        MemoryFilter::Not(child) => Filter::Not(Box::new(compile_valid_filter(child))),
        MemoryFilter::Predicate(predicate) => compile_predicate(predicate),
    }
}

fn compile_predicate(predicate: &MemoryPredicate) -> Filter {
    use FilterOperator as Op;

    let path = predicate.field.path();
    match predicate.operator {
        Op::Eq | Op::Ne | Op::Lt | Op::Lte | Op::Gt | Op::Gte => Filter::Compare {
            path,
            operator: compare_operator(predicate.operator),
            value: scalar_value(
                predicate.value.as_ref().expect("validated predicate value"),
                predicate.field,
            ),
        },
        Op::Prefix => Filter::Prefix {
            path,
            prefix: scalar_value(
                predicate.value.as_ref().expect("validated predicate value"),
                predicate.field,
            ),
        },
        Op::Contains => Filter::Contains {
            path,
            needle: scalar_value(
                predicate.value.as_ref().expect("validated predicate value"),
                predicate.field,
            ),
        },
        Op::In | Op::NotIn => compile_membership(predicate),
        Op::Between => compile_between(predicate),
        Op::IsNull => null_comparison(path),
        Op::IsNotNull => Filter::All(vec![
            Filter::Exists(path.clone()),
            Filter::Not(Box::new(null_comparison(path))),
        ]),
    }
}

fn compare_operator(operator: FilterOperator) -> CompareOperator {
    match operator {
        FilterOperator::Eq => CompareOperator::Equal,
        FilterOperator::Ne => CompareOperator::NotEqual,
        FilterOperator::Lt => CompareOperator::Less,
        FilterOperator::Lte => CompareOperator::LessOrEqual,
        FilterOperator::Gt => CompareOperator::Greater,
        FilterOperator::Gte => CompareOperator::GreaterOrEqual,
        _ => unreachable!("validated comparison operator"),
    }
}

fn compile_membership(predicate: &MemoryPredicate) -> Filter {
    let comparisons = list_values(
        predicate
            .value
            .as_ref()
            .expect("validated membership value"),
        predicate.field,
    )
    .into_iter()
    .map(|value| Filter::Compare {
        path: predicate.field.path(),
        operator: CompareOperator::Equal,
        value,
    })
    .collect();
    let included = Filter::Any(comparisons);
    if predicate.operator == FilterOperator::NotIn {
        Filter::Not(Box::new(included))
    } else {
        included
    }
}

fn compile_between(predicate: &MemoryPredicate) -> Filter {
    let mut endpoints = list_values(
        predicate.value.as_ref().expect("validated range value"),
        predicate.field,
    )
    .into_iter();
    let lower = endpoints.next().expect("validated lower endpoint");
    let upper = endpoints.next().expect("validated upper endpoint");
    Filter::All(vec![
        Filter::Compare {
            path: predicate.field.path(),
            operator: CompareOperator::GreaterOrEqual,
            value: lower,
        },
        Filter::Compare {
            path: predicate.field.path(),
            operator: CompareOperator::LessOrEqual,
            value: upper,
        },
    ])
}

fn null_comparison(path: FieldPath) -> Filter {
    Filter::Compare {
        path,
        operator: CompareOperator::Equal,
        value: Value::Null,
    }
}

fn scalar_value(value: &FilterValue, field: MemoryField) -> Value {
    match value {
        FilterValue::String(value) => Value::String(value.clone()),
        FilterValue::Integer(value) => Value::Integer(*value),
        FilterValue::Float(value) => Value::Integer(float_nanos(*value)),
        FilterValue::Strings(_) | FilterValue::Integers(_) | FilterValue::Floats(_) => {
            unreachable!("validated scalar value for {field:?}")
        }
    }
}

fn list_values(value: &FilterValue, field: MemoryField) -> Vec<Value> {
    match value {
        FilterValue::Strings(values) => values.iter().cloned().map(Value::String).collect(),
        FilterValue::Integers(values) => values.iter().copied().map(Value::Integer).collect(),
        FilterValue::Floats(values) => values
            .iter()
            .copied()
            .map(float_nanos)
            .map(Value::Integer)
            .collect(),
        FilterValue::String(_) | FilterValue::Integer(_) | FilterValue::Float(_) => {
            unreachable!("validated list value for {field:?}")
        }
    }
}

fn float_nanos(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value * NANOS).round() as i64
    }
}

/// Builds the non-bypassable memory kind, tenant, user and visibility filter.
///
/// This filter must be combined with the caller-provided filter using
/// [`Filter::All`], never replaced by it.
pub(crate) fn authorization_filter(scope: &RecallScope) -> Filter {
    let mut visibility = vec![string_eq("scope", "global")];

    if let Some(project_id) = &scope.project_id {
        visibility.push(Filter::All(vec![
            string_eq("scope", "project"),
            string_eq("project_id", project_id.as_str()),
        ]));

        if let Some(session_id) = &scope.session_id {
            visibility.push(Filter::All(vec![
                string_eq("scope", "session"),
                string_eq("project_id", project_id.as_str()),
                string_eq("session_id", session_id.as_str()),
            ]));
        }
    }

    Filter::All(vec![
        string_eq("kind", "memory"),
        string_eq("tenant_id", scope.tenant_id.as_str()),
        string_eq("user_id", scope.user_id.as_str()),
        Filter::Any(visibility),
    ])
}

fn string_eq(field: &str, value: &str) -> Filter {
    Filter::Compare {
        path: FieldPath::field(field),
        operator: CompareOperator::Equal,
        value: Value::String(value.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProjectId, SessionId, TenantId, UserId};

    fn predicate(
        field: MemoryField,
        operator: FilterOperator,
        value: Option<FilterValue>,
    ) -> MemoryFilter {
        MemoryFilter::Predicate(MemoryPredicate {
            field,
            operator,
            value,
        })
    }

    #[test]
    fn validates_each_field_category_operator_matrix() {
        let accepted = [
            (
                MemoryField::AgentId,
                FilterOperator::Prefix,
                FilterValue::String("a".into()),
            ),
            (
                MemoryField::Scope,
                FilterOperator::In,
                FilterValue::Strings(vec!["global".into()]),
            ),
            (
                MemoryField::Importance,
                FilterOperator::Gte,
                FilterValue::Float(0.5),
            ),
            (
                MemoryField::RetrievalCount,
                FilterOperator::Lt,
                FilterValue::Integer(4),
            ),
            (
                MemoryField::Tags,
                FilterOperator::Contains,
                FilterValue::String("rust".into()),
            ),
            (
                MemoryField::CreatedAt,
                FilterOperator::Between,
                FilterValue::Integers(vec![1, 2]),
            ),
        ];
        for (field, operator, value) in accepted {
            assert!(predicate(field, operator, Some(value)).validate().is_ok());
        }

        let rejected = [
            (
                MemoryField::Scope,
                FilterOperator::Prefix,
                FilterValue::String("g".into()),
            ),
            (
                MemoryField::Tags,
                FilterOperator::Eq,
                FilterValue::String("rust".into()),
            ),
            (
                MemoryField::AgentId,
                FilterOperator::Gt,
                FilterValue::String("a".into()),
            ),
            (
                MemoryField::Importance,
                FilterOperator::Contains,
                FilterValue::Float(0.5),
            ),
            (
                MemoryField::CreatedAt,
                FilterOperator::Prefix,
                FilterValue::Integer(1),
            ),
        ];
        for (field, operator, value) in rejected {
            assert!(matches!(
                predicate(field, operator, Some(value)).validate(),
                Err(MemoryFilterError::InvalidOperator { .. })
            ));
        }
    }

    #[test]
    fn validates_nullability_and_value_presence() {
        assert!(
            predicate(MemoryField::EventAt, FilterOperator::IsNull, None)
                .validate()
                .is_ok()
        );
        assert!(matches!(
            predicate(MemoryField::CreatedAt, FilterOperator::IsNull, None).validate(),
            Err(MemoryFilterError::InvalidOperator { .. })
        ));
        assert!(matches!(
            predicate(
                MemoryField::EventAt,
                FilterOperator::IsNull,
                Some(FilterValue::Integer(1))
            )
            .validate(),
            Err(MemoryFilterError::UnexpectedValue { .. })
        ));
        assert!(matches!(
            predicate(MemoryField::State, FilterOperator::Eq, None).validate(),
            Err(MemoryFilterError::MissingValue { .. })
        ));
    }

    #[test]
    fn rejects_wrong_value_variants() {
        let cases = [
            predicate(
                MemoryField::Importance,
                FilterOperator::Eq,
                Some(FilterValue::Integer(1)),
            ),
            predicate(
                MemoryField::CreatedAt,
                FilterOperator::Eq,
                Some(FilterValue::Float(1.0)),
            ),
            predicate(
                MemoryField::State,
                FilterOperator::In,
                Some(FilterValue::Integers(vec![1])),
            ),
            predicate(
                MemoryField::Strength,
                FilterOperator::Between,
                Some(FilterValue::Integers(vec![0, 1])),
            ),
        ];
        for filter in cases {
            assert!(matches!(
                filter.validate(),
                Err(MemoryFilterError::InvalidValue { .. })
            ));
        }
    }

    #[test]
    fn enforces_list_range_and_float_limits() {
        assert!(matches!(
            predicate(
                MemoryField::State,
                FilterOperator::In,
                Some(FilterValue::Strings(Vec::new()))
            )
            .validate(),
            Err(MemoryFilterError::EmptyList)
        ));
        assert!(matches!(
            predicate(
                MemoryField::State,
                FilterOperator::In,
                Some(FilterValue::Strings(vec!["x".into(); 51]))
            )
            .validate(),
            Err(MemoryFilterError::TooManyValues { actual: 51, .. })
        ));
        assert!(matches!(
            predicate(
                MemoryField::CreatedAt,
                FilterOperator::Between,
                Some(FilterValue::Integers(vec![1]))
            )
            .validate(),
            Err(MemoryFilterError::InvalidRangeLength { actual: 1 })
        ));
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(matches!(
                predicate(
                    MemoryField::Importance,
                    FilterOperator::Eq,
                    Some(FilterValue::Float(value))
                )
                .validate(),
                Err(MemoryFilterError::NonFiniteFloat)
            ));
        }
    }

    #[test]
    fn enforces_node_and_depth_budgets_at_boundaries() {
        let leaf = || {
            predicate(
                MemoryField::State,
                FilterOperator::Eq,
                Some(FilterValue::String("active".into())),
            )
        };
        assert!(
            MemoryFilter::All((0..63).map(|_| leaf()).collect())
                .validate()
                .is_ok()
        );
        assert!(matches!(
            MemoryFilter::All((0..64).map(|_| leaf()).collect()).validate(),
            Err(MemoryFilterError::TooManyNodes { actual: 65, .. })
        ));

        let mut depth_eight = MemoryFilter::MatchAll;
        for _ in 0..7 {
            depth_eight = MemoryFilter::Not(Box::new(depth_eight));
        }
        assert!(depth_eight.validate().is_ok());
        assert!(matches!(
            MemoryFilter::Not(Box::new(depth_eight)).validate(),
            Err(MemoryFilterError::TooDeep { actual: 9, .. })
        ));
    }

    #[test]
    fn compiles_float_membership_and_between_to_integer_nanos() {
        let membership = predicate(
            MemoryField::Importance,
            FilterOperator::In,
            Some(FilterValue::Floats(vec![0.25, 0.5])),
        )
        .compile()
        .expect("valid membership");
        assert_eq!(
            membership,
            Filter::Any(vec![
                Filter::Compare {
                    path: FieldPath::field("importance"),
                    operator: CompareOperator::Equal,
                    value: Value::Integer(250_000_000),
                },
                Filter::Compare {
                    path: FieldPath::field("importance"),
                    operator: CompareOperator::Equal,
                    value: Value::Integer(500_000_000),
                },
            ])
        );

        assert_eq!(
            predicate(
                MemoryField::Valence,
                FilterOperator::Between,
                Some(FilterValue::Floats(vec![-0.5, 0.75]))
            )
            .compile()
            .expect("valid range"),
            Filter::All(vec![
                Filter::Compare {
                    path: FieldPath::field("valence"),
                    operator: CompareOperator::GreaterOrEqual,
                    value: Value::Integer(-500_000_000),
                },
                Filter::Compare {
                    path: FieldPath::field("valence"),
                    operator: CompareOperator::LessOrEqual,
                    value: Value::Integer(750_000_000),
                },
            ])
        );
    }

    #[test]
    fn compiles_not_in_and_non_null_without_missing_value_leaks() {
        let not_in = predicate(
            MemoryField::State,
            FilterOperator::NotIn,
            Some(FilterValue::Strings(vec!["archived".into()])),
        )
        .compile()
        .expect("valid exclusion");
        assert!(matches!(not_in, Filter::Not(_)));

        let non_null = predicate(MemoryField::SourceId, FilterOperator::IsNotNull, None)
            .compile()
            .expect("valid null test");
        assert_eq!(
            non_null,
            Filter::All(vec![
                Filter::Exists(FieldPath::field("source_id")),
                Filter::Not(Box::new(Filter::Compare {
                    path: FieldPath::field("source_id"),
                    operator: CompareOperator::Equal,
                    value: Value::Null,
                })),
            ])
        );
    }

    #[test]
    fn compiles_boolean_structure_without_rewriting_it() {
        let filter = MemoryFilter::All(vec![
            MemoryFilter::MatchAll,
            MemoryFilter::Not(Box::new(MemoryFilter::Any(Vec::new()))),
        ]);
        assert_eq!(
            filter.compile().expect("valid expression"),
            Filter::All(vec![
                Filter::MatchAll,
                Filter::Not(Box::new(Filter::Any(Vec::new()))),
            ])
        );
    }

    #[test]
    fn authorization_always_requires_kind_tenant_user_and_global_visibility() {
        let scope = RecallScope {
            tenant_id: TenantId::new("tenant-a").expect("valid tenant"),
            user_id: UserId::new("user-a").expect("valid user"),
            project_id: None,
            conversation_id: None,
            session_id: Some(SessionId::new("unusable-session").expect("valid session")),
        };
        assert_eq!(
            authorization_filter(&scope),
            Filter::All(vec![
                string_eq("kind", "memory"),
                string_eq("tenant_id", "tenant-a"),
                string_eq("user_id", "user-a"),
                Filter::Any(vec![string_eq("scope", "global")]),
            ])
        );
    }

    #[test]
    fn authorization_adds_project_and_session_visibility_only_with_required_ids() {
        let scope = RecallScope {
            tenant_id: TenantId::new("tenant-a").expect("valid tenant"),
            user_id: UserId::new("user-a").expect("valid user"),
            project_id: Some(ProjectId::new("project-a").expect("valid project")),
            conversation_id: None,
            session_id: Some(SessionId::new("session-a").expect("valid session")),
        };
        let Filter::All(parts) = authorization_filter(&scope) else {
            panic!("authorization root must be all");
        };
        assert_eq!(parts.len(), 4);
        assert_eq!(
            parts[3],
            Filter::Any(vec![
                string_eq("scope", "global"),
                Filter::All(vec![
                    string_eq("scope", "project"),
                    string_eq("project_id", "project-a"),
                ]),
                Filter::All(vec![
                    string_eq("scope", "session"),
                    string_eq("project_id", "project-a"),
                    string_eq("session_id", "session-a"),
                ]),
            ])
        );
    }
}
