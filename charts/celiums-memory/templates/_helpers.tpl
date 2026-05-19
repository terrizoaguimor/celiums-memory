{{/*
Expand the name of the chart.
*/}}
{{- define "celiums-memory.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncated at 63 chars (DNS) and trimmed of trailing '-'.
*/}}
{{- define "celiums-memory.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label string (name + version).
*/}}
{{- define "celiums-memory.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Canonical labels applied to every object.
*/}}
{{- define "celiums-memory.labels" -}}
helm.sh/chart: {{ include "celiums-memory.chart" . }}
{{ include "celiums-memory.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: celiums
{{- end }}

{{/*
Selector labels — used by Service, Deployment.selector.
Stable across upgrades; do NOT include version or chart.
*/}}
{{- define "celiums-memory.selectorLabels" -}}
app.kubernetes.io/name: {{ include "celiums-memory.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "celiums-memory.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "celiums-memory.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
