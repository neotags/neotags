{{- define "neotags.name" -}}{{ .Chart.Name }}{{- end }}

{{- define "neotags.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end }}

{{- define "neotags.labels" -}}
app.kubernetes.io/name: {{ include "neotags.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "neotags.selectorLabels" -}}
app.kubernetes.io/name: {{ include "neotags.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "neotags.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ default (include "neotags.fullname" .) .Values.serviceAccount.name }}
{{- else -}}{{ default "default" .Values.serviceAccount.name }}{{- end -}}
{{- end }}
