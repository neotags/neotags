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

{{/* The neotags config file: .Values.config plus what the chart owns (the skill pack dir, the sandbox backend). */}}
{{- define "neotags.config" -}}
{{- $cfg := deepCopy .Values.config -}}
{{- if .Values.skillPacks.configMap -}}
{{- $sp := default dict $cfg.skillPacks -}}
{{- $_ := set $sp "dir" "/etc/neotags/skills" -}}
{{- $_ := set $cfg "skillPacks" $sp -}}
{{- end -}}
{{- if .Values.executor.enabled -}}
{{- $_ := set $cfg "sandbox" (dict "backend" "local" "socket" (printf "%s/exec.sock" .Values.executor.socketDir)) -}}
{{- end -}}
{{- toYaml $cfg -}}
{{- end }}

{{- define "neotags.o2Enabled" -}}
{{- if and .Values.config.o2Gateway .Values.config.o2Gateway.enabled -}}true{{- end -}}
{{- end }}

{{- define "neotags.o2Port" -}}
{{- (and .Values.config.o2Gateway .Values.config.o2Gateway.port) | default 3001 -}}
{{- end }}

{{/* terminationGracePeriodSeconds: the value, else 660 with the O2 gateway (agent runs drain) and 30 without. */}}
{{- define "neotags.grace" -}}
{{- if ne (toString .Values.terminationGracePeriodSeconds) "" -}}{{ .Values.terminationGracePeriodSeconds }}
{{- else if include "neotags.o2Enabled" . -}}660
{{- else -}}30{{- end -}}
{{- end }}

{{- define "neotags.o2ServicePort" -}}
{{- if ne (toString .Values.service.o2Port) "" -}}{{ .Values.service.o2Port }}{{- else -}}{{ include "neotags.o2Port" . }}{{- end -}}
{{- end }}
