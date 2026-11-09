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

{{/* A value left unset: absent, null or "". 0 is a value. */}}
{{- define "neotags.isUnset" -}}
{{- if or (kindIs "invalid" .) (eq (toString .) "") -}}true{{- end -}}
{{- end }}

{{/* config.agent.drainSec as the app reads it (default 640). */}}
{{- define "neotags.drainSec" -}}
{{- if and .Values.config.agent .Values.config.agent.drainSec -}}{{ float64 .Values.config.agent.drainSec }}{{- else -}}640{{- end -}}
{{- end }}

{{/*
terminationGracePeriodSeconds: the value, else with the O2 gateway the drain plus 20 s (the process still closes the
O2 server and MCP and flushes traces after it; 660 with the defaults), else 30.
*/}}
{{- define "neotags.grace" -}}
{{- if not (include "neotags.isUnset" .Values.terminationGracePeriodSeconds) -}}{{ .Values.terminationGracePeriodSeconds }}
{{- else if include "neotags.o2Enabled" . -}}{{ addf (ceil (float64 (include "neotags.drainSec" .))) 20 | int }}
{{- else -}}30{{- end -}}
{{- end }}

{{- define "neotags.o2ServicePort" -}}
{{- if not (include "neotags.isUnset" .Values.service.o2Port) -}}{{ .Values.service.o2Port }}{{- else -}}{{ include "neotags.o2Port" . }}{{- end -}}
{{- end }}

{{/* A memory quantity (512Mi, 2Gi, 1G, 2147483648) in MiB; fails on a form it cannot read. */}}
{{- define "neotags.mib" -}}
{{- /* A YAML number arrives as a float (2.147483648e+09): print it as the integer it is. */}}
{{- $q := ternary (printf "%.0f" (float64 .)) (toString .) (or (kindIs "float64" .) (kindIs "int64" .) (kindIs "int" .)) -}}
{{- $m := regexFind "^[0-9.]+" $q -}}
{{- $unit := trimPrefix $m $q -}}
{{- /* Bytes per unit; divided once at the end, so 2147483648 is exactly 2048. */}}
{{- $bytes := dict "Ki" 1024.0 "Mi" 1048576.0 "Gi" 1073741824.0 "Ti" 1099511627776.0 "K" 1e3 "M" 1e6 "G" 1e9 "T" 1e12 "" 1.0 -}}
{{- if or (eq $m "") (not (hasKey $bytes $unit)) -}}{{ fail (printf "cannot read the memory quantity %q" $q) }}{{- end -}}
{{- divf (mulf (float64 $m) (get $bytes $unit)) 1048576 -}}
{{- end }}
