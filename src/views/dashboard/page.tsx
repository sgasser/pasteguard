import type { FC } from "hono/jsx";

const DashboardPage: FC = () => {
	return (
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>PasteGuard Dashboard</title>
				<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
				<link rel="stylesheet" href="/dashboard/tailwind.css" />
				<style
					// biome-ignore lint/security/noDangerouslySetInnerHtml: Custom CSS
					dangerouslySetInnerHTML={{
						__html: `
							:root {
								/* Brand Colors */
								--color-accent: #b45309;
								--color-accent-hover: #92400e;
								--color-accent-light: #d97706;
								--color-accent-bg: #fef3c7;
								--color-accent-bg-subtle: #fffbeb;

								/* Background Colors (Stone) */
								--color-bg-page: #fafaf9;
								--color-bg-surface: #ffffff;
								--color-bg-elevated: #f5f5f4;
								--color-border: #e7e5e4;
								--color-border-subtle: #f5f5f4;

								/* Text Colors (Stone) */
								--color-text-primary: #1c1917;
								--color-text-secondary: #44403c;
								--color-text-muted: #57534e;
								--color-text-subtle: #78716c;

								/* Semantic Colors */
								--color-success: #16a34a;
								--color-success-bg: #dcfce7;
								--color-error: #dc2626;
								--color-error-bg: #fee2e2;
								--color-info: #2563eb;
								--color-info-bg: #dbeafe;
								--color-teal: #0d9488;
								--color-anthropic: #d97706;

								/* Code Block Colors */
								--color-code-bg: #1c1917;
								--color-code-header: #292524;
								--color-code-text: #e7e5e4;
								--color-code-muted: #a8a29e;

								/* Typography */
								--font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
								--font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
								--tracking-tight: -0.02em;

								/* Border Radius Scale */
								--radius-sm: 6px;
								--radius-md: 8px;
								--radius-lg: 12px;
								--radius-xl: 16px;

								/* Shadow Scale */
								--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
								--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -1px rgba(0, 0, 0, 0.04);
								--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -2px rgba(0, 0, 0, 0.04);

								/* Motion */
								--duration-fast: 150ms;
								--duration-normal: 200ms;
								--ease-out: cubic-bezier(0, 0, 0.2, 1);
							}

							* { box-sizing: border-box; }

							body {
								font-family: var(--font-sans);
								background: var(--color-bg-page);
								color: var(--color-text-primary);
								line-height: 1.6;
							}

							.font-mono { font-family: var(--font-mono); }

							/* Background utilities */
							.bg-page { background: var(--color-bg-page); }
							.bg-surface { background: var(--color-bg-surface); }
							.bg-elevated { background: var(--color-bg-elevated); }
							.bg-detail { background: var(--color-bg-page); }
							.bg-accent { background: var(--color-accent); }
							.bg-accent-bg { background: var(--color-accent-bg); }
							.bg-accent\\/10 { background: rgba(180, 83, 9, 0.1); }
							.bg-info { background: var(--color-info); }
							.bg-info\\/10 { background: rgba(37, 99, 235, 0.1); }
							.bg-success { background: var(--color-success); }
							.bg-success\\/10 { background: rgba(22, 163, 74, 0.1); }
							.bg-teal { background: var(--color-teal); }
							.bg-anthropic { background: var(--color-anthropic); }
							.bg-anthropic\\/10 { background: rgba(217, 119, 6, 0.1); }
							.bg-error { background: var(--color-error); }
							.bg-error\\/10 { background: rgba(220, 38, 38, 0.1); }

							/* Border utilities */
							.border-border { border-color: var(--color-border); }
							.border-border-subtle { border-color: var(--color-border-subtle); }
							.border-accent\\/20 { border-color: rgba(180, 83, 9, 0.2); }
							.border-success\\/20 { border-color: rgba(22, 163, 74, 0.2); }
							.border-error\\/20 { border-color: rgba(220, 38, 38, 0.2); }

							/* Text utilities */
							.text-text-primary { color: var(--color-text-primary); }
							.text-text-secondary { color: var(--color-text-secondary); }
							.text-text-muted { color: var(--color-text-muted); }
							.text-accent { color: var(--color-accent); }
							.text-info { color: var(--color-info); }
							.text-success { color: var(--color-success); }
							.text-teal { color: var(--color-teal); }
							.text-anthropic { color: var(--color-anthropic); }
							.text-error { color: var(--color-error); }

							/* Border radius */
							.rounded-sm { border-radius: var(--radius-sm); }
							.rounded-md { border-radius: var(--radius-md); }
							.rounded-lg { border-radius: var(--radius-lg); }
							.rounded-xl { border-radius: var(--radius-xl); }

							/* Shadows */
							.shadow-sm { box-shadow: var(--shadow-sm); }
							.shadow-md { box-shadow: var(--shadow-md); }

							/* Animations */
							@keyframes pulse {
								0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.3); }
								50% { opacity: 0.8; box-shadow: 0 0 0 4px rgba(22, 163, 74, 0); }
							}
							@keyframes spin {
								to { transform: rotate(360deg); }
							}
							@keyframes fadeIn {
								from { opacity: 0; transform: translateY(6px); }
								to { opacity: 1; transform: translateY(0); }
							}
							@keyframes slideDown {
								from { opacity: 0; transform: translateY(-8px); }
								to { opacity: 1; transform: translateY(0); }
							}
							@keyframes pulseBar {
								0%, 100% { opacity: 0.3; }
								50% { opacity: 1; }
							}
							.animate-pulse-dot { animation: pulse 2s ease-in-out infinite; }
							.animate-spin { animation: spin 0.8s linear infinite; }
							.animate-fade-in { animation: fadeIn 0.35s var(--ease-out) backwards; }
							.animate-slide-down { animation: slideDown 0.25s var(--ease-out); }

							/* Brand signature: Redaction Bar Loader */
							.loader-bars {
								display: flex;
								flex-direction: column;
								gap: 6px;
							}
							.loader-bar {
								height: 6px;
								border-radius: 3px;
								background: var(--color-accent);
								animation: pulseBar 1.5s ease-in-out infinite;
							}
							.loader-bar:nth-child(1) { width: 60px; animation-delay: 0s; }
							.loader-bar:nth-child(2) { width: 45px; animation-delay: 0.15s; }
							.loader-bar:nth-child(3) { width: 52px; animation-delay: 0.3s; }

							/* Route mode visibility */
							.route-only { display: none; }
							[data-mode="route"] .route-only { display: block; }
							[data-mode="route"] th.route-only,
							[data-mode="route"] td.route-only { display: table-cell; }

							/* Transitions */
							.transition-all {
								transition: all var(--duration-fast) var(--ease-out);
							}
							.transition-colors {
								transition: background-color var(--duration-fast) var(--ease-out),
								            border-color var(--duration-fast) var(--ease-out),
								            color var(--duration-fast) var(--ease-out);
							}
							.transition-transform {
								transition: transform var(--duration-fast) var(--ease-out);
							}

							/* Card hover effect */
							.card-hover:hover {
								box-shadow: var(--shadow-md);
								transform: translateY(-2px);
								border-color: #d3ab8c; /* fallback for browsers without color-mix */
								border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
							}
						`,
					}}
				/>
			</head>
			<body class="bg-page text-text-primary min-h-screen font-sans antialiased leading-relaxed">
				<div class="max-w-[1320px] mx-auto p-8 px-6">
					<Header />
					<StatsGrid />
					<Charts />
					<LogsSection />
				</div>
				<ClientScript />
			</body>
		</html>
	);
};

const Header: FC = () => (
	<header class="flex justify-between items-center mb-10">
		<div class="flex items-center gap-3">
			<svg class="w-9 h-9" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M32 6C20 6 12 12 12 12v20c0 12 8 22 20 26 12-4 20-14 20-26V12s-8-6-20-6z" stroke="var(--color-accent)" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
				<rect x="22" y="24" width="20" height="4" rx="2" fill="var(--color-accent)"/>
				<rect x="22" y="32" width="14" height="4" rx="2" fill="var(--color-accent)" opacity="0.6"/>
				<rect x="22" y="40" width="17" height="4" rx="2" fill="var(--color-accent)" opacity="0.3"/>
			</svg>
			<div class="text-xl font-bold text-text-primary" style="letter-spacing: var(--tracking-tight)">
				Paste<span class="text-accent">Guard</span>
			</div>
		</div>
		<div class="flex items-center gap-4">
			<span
				id="mode-badge"
				class="inline-flex items-center px-3 py-1.5 rounded-md font-mono text-[0.7rem] font-medium tracking-wide uppercase bg-elevated text-text-muted"
			>
				—
			</span>
			<div class="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-full text-xs text-text-secondary shadow-sm">
				<div class="w-[7px] h-[7px] bg-success rounded-full animate-pulse-dot" />
				<span>Live</span>
			</div>
		</div>
	</header>
);

const StatsGrid: FC = () => (
	<div
		id="stats-grid"
		class="grid grid-cols-4 gap-4 mb-8 [&[data-mode='route']]:grid-cols-6"
	>
		<StatCard label="Total Requests" valueId="total-requests" />
		<StatCard
			id="pii-card"
			label="Routed Local"
			labelId="pii-label"
			valueId="pii-requests"
			accent="accent"
		/>
		<StatCard label="Avg PII Scan" valueId="avg-scan" accent="teal" />
		<StatCard label="Requests/Hour" valueId="requests-hour" />
		<StatCard
			id="openai-card"
			label="OpenAI"
			valueId="openai-requests"
			accent="info"
			routeOnly
		/>
		<StatCard
			id="local-card"
			label="Local"
			valueId="local-requests"
			accent="success"
			routeOnly
		/>
	</div>
);

const StatCard: FC<{
	id?: string;
	label: string;
	labelId?: string;
	valueId: string;
	accent?: "accent" | "info" | "success" | "teal";
	routeOnly?: boolean;
}> = ({ id, label, labelId, valueId, accent, routeOnly }) => {
	const accentClass = accent
		? {
				accent: "text-accent",
				info: "text-info",
				success: "text-success",
				teal: "text-teal",
			}[accent]
		: "";

	return (
		<div
			id={id}
			class={`bg-surface border border-border-subtle rounded-xl p-5 shadow-sm transition-all card-hover animate-fade-in ${routeOnly ? "route-only" : ""}`}
		>
			<div
				id={labelId}
				class="text-[0.7rem] font-medium uppercase tracking-widest text-text-muted mb-2"
			>
				{label}
			</div>
			<div
				id={valueId}
				class={`text-3xl font-bold tabular-nums ${accentClass}`}
				style="letter-spacing: var(--tracking-tight)"
			>
				—
			</div>
		</div>
	);
};

const Charts: FC = () => (
	<div class="grid grid-cols-1 gap-4 mb-8 [&[data-mode='route']]:grid-cols-2">
		<div
			id="provider-chart"
			class="route-only bg-surface border border-border-subtle rounded-xl p-6 shadow-sm animate-fade-in"
		>
			<div class="text-[0.8rem] font-semibold text-text-secondary mb-5 uppercase tracking-wide">
				Provider Distribution
			</div>
			<div
				id="provider-split"
				class="flex h-10 rounded-md overflow-hidden bg-elevated"
			>
				<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-info min-w-[48px] transition-all w-1/2">
					50%
				</div>
				<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-success min-w-[48px] transition-all w-1/2">
					50%
				</div>
			</div>
			<div class="flex gap-6 mt-4">
				<div class="flex items-center gap-2 text-xs text-text-secondary">
					<div class="w-2.5 h-2.5 rounded-sm bg-info" />
					<span>Upstream</span>
				</div>
				<div class="flex items-center gap-2 text-xs text-text-secondary">
					<div class="w-2.5 h-2.5 rounded-sm bg-success" />
					<span>Local</span>
				</div>
			</div>
		</div>
		<div
			id="entity-chart-card"
			class="bg-surface border border-border-subtle rounded-xl p-6 shadow-sm animate-fade-in"
		>
			<div class="text-[0.8rem] font-semibold text-text-secondary mb-5 uppercase tracking-wide">
				Entity Types Detected
			</div>
			<div id="entity-chart" class="flex flex-col gap-2.5">
				<div class="flex flex-col items-center py-10 gap-3">
					<div class="loader-bars" style="opacity: 0.3">
						<div class="loader-bar" style="animation: none" />
						<div class="loader-bar" style="animation: none" />
						<div class="loader-bar" style="animation: none" />
					</div>
					<div class="text-sm text-text-muted">No PII detected yet</div>
				</div>
			</div>
		</div>
	</div>
);

const LogsSection: FC = () => (
	<>
		<div class="text-[0.8rem] font-semibold text-text-secondary mb-4 uppercase tracking-wide">
			Recent Requests
		</div>
		<div class="bg-surface border border-border-subtle rounded-xl shadow-sm overflow-hidden animate-fade-in">
			<div class="overflow-x-auto">
				<table class="w-full min-w-[700px] border-collapse">
					<thead>
						<tr>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Time
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Status
							</th>
							<th class="route-only bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Provider
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Model
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Language
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								PII Entities
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Secrets
							</th>
							<th class="bg-elevated font-mono text-[0.65rem] font-medium uppercase tracking-widest text-text-muted px-4 py-3.5 text-left border-b border-border sticky top-0">
								Scan Time
							</th>
						</tr>
					</thead>
					<tbody id="logs-body">
						<tr>
							<td colSpan={8}>
								<div class="flex flex-col justify-center items-center p-10 gap-3">
									<div class="loader-bars">
										<div class="loader-bar" />
										<div class="loader-bar" />
										<div class="loader-bar" />
									</div>
									<span class="text-text-muted text-sm">Loading requests...</span>
								</div>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</>
);

const ClientScript: FC = () => (
	<script
		// biome-ignore lint/security/noDangerouslySetInnerHtml: Client-side JS
		dangerouslySetInnerHTML={{
			__html: `
let currentMode = null;
let expandedRowId = null;

async function fetchStats() {
  try {
    const res = await fetch('/dashboard/api/stats');
    const data = await res.json();

    if (currentMode !== data.mode) {
      currentMode = data.mode;
      document.body.dataset.mode = data.mode;
    }

    document.getElementById('total-requests').textContent = data.total_requests.toLocaleString();
    document.getElementById('avg-scan').textContent = data.avg_scan_time_ms + 'ms';
    document.getElementById('requests-hour').textContent = data.requests_last_hour.toLocaleString();

    const modeBadge = document.getElementById('mode-badge');
    modeBadge.textContent = data.mode.toUpperCase();
    modeBadge.className = data.mode === 'route'
      ? 'inline-flex items-center px-3 py-1.5 rounded-md font-mono text-[0.7rem] font-medium tracking-wide uppercase bg-success/10 text-success border border-success/20'
      : 'inline-flex items-center px-3 py-1.5 rounded-md font-mono text-[0.7rem] font-medium tracking-wide uppercase bg-accent/10 text-accent border border-accent/20';

    const piiLabel = document.getElementById('pii-label');
    if (data.mode === 'mask') {
      piiLabel.textContent = 'Masked';
      document.getElementById('pii-requests').textContent = data.pii_requests.toLocaleString() + ' (' + data.pii_percentage + '%)';
    } else {
      piiLabel.textContent = 'Routed Local';
      document.getElementById('pii-requests').textContent = data.local_requests.toLocaleString();
    }

    if (data.mode === 'route') {
      document.getElementById('openai-requests').textContent = data.openai_requests.toLocaleString();
      document.getElementById('local-requests').textContent = data.local_requests.toLocaleString();

      const total = data.openai_requests + data.local_requests;
      const openaiPct = total > 0 ? Math.round((data.openai_requests / total) * 100) : 50;
      const localPct = 100 - openaiPct;

      document.getElementById('provider-split').innerHTML =
        '<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-info min-w-[48px] transition-all" style="width:' + Math.max(openaiPct, 10) + '%">' + openaiPct + '%</div>' +
        '<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-success min-w-[48px] transition-all" style="width:' + Math.max(localPct, 10) + '%">' + localPct + '%</div>';
    }

    const chartEl = document.getElementById('entity-chart');
    if (data.entity_breakdown && data.entity_breakdown.length > 0) {
      const maxCount = Math.max(...data.entity_breakdown.map(e => e.count));
      chartEl.innerHTML = data.entity_breakdown.slice(0, 6).map(e =>
        '<div class="grid grid-cols-[100px_1fr_40px] items-center gap-3">' +
          '<div class="font-mono text-[0.65rem] text-text-secondary truncate">' + e.entity + '</div>' +
          '<div class="h-1.5 bg-elevated rounded-sm overflow-hidden">' +
            '<div class="h-full bg-accent rounded-sm transition-all" style="width:' + ((e.count / maxCount) * 100) + '%"></div>' +
          '</div>' +
          '<div class="font-mono text-[0.7rem] font-medium text-right text-text-primary">' + e.count + '</div>' +
        '</div>'
      ).join('');
    } else {
      chartEl.innerHTML = '<div class="flex flex-col items-center py-10 gap-3"><div class="loader-bars" style="opacity:0.3"><div class="loader-bar" style="animation:none"></div><div class="loader-bar" style="animation:none"></div><div class="loader-bar" style="animation:none"></div></div><div class="text-sm text-text-muted">No PII detected yet</div></div>';
    }
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

function toggleRow(logId) {
  const wasExpanded = expandedRowId === logId;

  // Hide all detail rows and reset all arrows
  document.querySelectorAll('.detail-row-visible').forEach(el => {
    el.classList.remove('detail-row-visible');
    el.classList.add('hidden');
  });
  document.querySelectorAll('.log-row-expanded').forEach(el => el.classList.remove('log-row-expanded'));
  document.querySelectorAll('.arrow-icon').forEach(el => {
    el.classList.remove('rotate-90', 'bg-accent/10', 'text-accent');
    el.classList.add('bg-elevated', 'text-text-muted');
  });

  if (!wasExpanded) {
    const logRow = document.getElementById('log-' + logId);
    const detailRow = document.getElementById('detail-' + logId);
    const arrow = document.getElementById('arrow-' + logId);

    if (logRow && detailRow) {
      logRow.classList.add('log-row-expanded');
      detailRow.classList.remove('hidden');
      detailRow.classList.add('detail-row-visible');

      if (arrow) {
        arrow.classList.remove('bg-elevated', 'text-text-muted');
        arrow.classList.add('rotate-90', 'bg-accent/10', 'text-accent');
      }

      expandedRowId = logId;
    }
  } else {
    expandedRowId = null;
  }
}

function formatMaskedPreview(maskedContent, entities) {
  if (maskedContent) {
    return maskedContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\\[\\[([A-Z_]+_\\d+)\\]\\]/g, '<span class="bg-accent-bg text-accent px-1 py-0.5 rounded-sm font-medium">[[$1]]</span>');
  }
  if (!entities || entities.length === 0) {
    return '<span class="text-text-muted">No PII detected in this request</span>';
  }
  return '<span class="text-text-muted">Masked content not logged (log_masked_content: false)</span>';
}

function renderEntityList(entities) {
  if (!entities || entities.length === 0) {
    return '<div class="text-sm text-text-muted p-3 bg-surface border border-dashed border-border rounded-lg text-center">No entities detected</div>';
  }
  const counts = {};
  for (const e of entities) counts[e] = (counts[e] || 0) + 1;
  return '<div class="flex flex-col gap-1.5">' + Object.entries(counts).map(([type, count]) =>
    '<div class="flex items-center gap-2.5 text-xs p-2 px-3 bg-surface border border-border-subtle rounded-md">' +
      '<span class="font-mono text-[0.65rem] font-medium px-1.5 py-0.5 bg-accent/10 text-accent rounded-sm">' + type + '</span>' +
      '<span class="font-mono text-[0.7rem] text-text-primary flex-1">' + count + ' ' + (count === 1 ? 'instance' : 'instances') + '</span>' +
    '</div>'
  ).join('') + '</div>';
}

async function fetchLogs() {
  try {
    const res = await fetch('/dashboard/api/logs?limit=50');
    const data = await res.json();
    const tbody = document.getElementById('logs-body');

    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="text-center py-10 text-text-muted"><div class="text-2xl mb-3 opacity-40">📋</div><div class="text-sm">No requests yet</div></div></td></tr>';
      return;
    }

    tbody.innerHTML = data.logs.map((log, index) => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const entities = log.entities ? log.entities.split(',').filter(e => e.trim()) : [];
      const secretsTypes = log.secrets_types ? log.secrets_types.split(',').filter(s => s.trim()) : [];
      const secretsDetected = log.secrets_detected === 1;
      const isError = log.status_code && log.status_code >= 400;
      const lang = log.language || 'en';
      const detectedLang = log.detected_language;

      const formatLang = (code) => code ? code.toUpperCase() : lang.toUpperCase();

      // Show original→fallback when fallback was used (e.g. FR→EN)
      const langDisplay = log.language_fallback && detectedLang
        ? '<span class="text-accent" title="Language not supported, fallback used">' + formatLang(detectedLang) + '</span><span class="text-text-muted text-[0.5rem] mx-0.5">→</span><span>' + lang.toUpperCase() + '</span>'
        : lang.toUpperCase();
      const logId = log.id || index;
      const isExpanded = expandedRowId === logId;

      const statusBadge = isError
        ? '<span class="inline-flex items-center px-2 py-1 rounded-sm font-mono text-[0.6rem] font-medium uppercase tracking-wide bg-error/10 text-error">' + log.status_code + '</span>'
        : '<span class="inline-flex items-center px-2 py-1 rounded-sm font-mono text-[0.6rem] font-medium uppercase tracking-wide bg-success/10 text-success">OK</span>';

      const mainRow =
        '<tr id="log-' + logId + '" class="cursor-pointer transition-colors hover:bg-elevated ' + (isExpanded ? 'log-row-expanded bg-elevated' : '') + '" onclick="toggleRow(' + logId + ')">' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            '<span id="arrow-' + logId + '" class="arrow-icon inline-flex items-center justify-center w-[18px] h-[18px] mr-2 rounded-sm bg-elevated text-text-muted text-[0.65rem] transition-transform ' + (isExpanded ? 'rotate-90 bg-accent/10 text-accent' : '') + '">▶</span>' +
            '<span class="font-mono text-[0.7rem] text-text-secondary">' + time + '</span>' +
          '</td>' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' + statusBadge + '</td>' +
          '<td class="route-only text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            '<span class="inline-flex items-center px-2 py-1 rounded-sm font-mono text-[0.6rem] font-medium uppercase tracking-wide ' +
              (log.provider === 'openai' ? 'bg-info/10 text-info' : log.provider === 'anthropic' ? 'bg-anthropic/10 text-anthropic' : 'bg-success/10 text-success') + '">' + log.provider + '</span>' +
          '</td>' +
          '<td class="font-mono text-[0.7rem] text-text-secondary px-4 py-3 border-b border-border-subtle align-middle">' + log.model + '</td>' +
          '<td class="font-mono text-[0.65rem] font-medium px-4 py-3 border-b border-border-subtle align-middle">' + langDisplay + '</td>' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            (entities.length > 0
              ? '<div class="flex flex-wrap gap-1">' + entities.map(e => '<span class="font-mono text-[0.55rem] px-1.5 py-0.5 bg-elevated border border-border rounded-sm text-text-secondary">' + e.trim() + '</span>').join('') + '</div>'
              : '<span class="text-text-muted">—</span>') +
          '</td>' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            (secretsDetected
              ? '<div class="flex flex-wrap gap-1">' + (secretsTypes.length > 0 ? secretsTypes.map(s => '<span class="font-mono text-[0.55rem] px-1.5 py-0.5 bg-error/10 border border-error/20 rounded-sm text-error">' + s.trim() + '</span>').join('') : '<span class="font-mono text-[0.55rem] px-1.5 py-0.5 bg-error/10 border border-error/20 rounded-sm text-error">DETECTED</span>') + '</div>'
              : '<span class="text-text-muted">—</span>') +
          '</td>' +
          '<td class="font-mono text-[0.7rem] text-teal px-4 py-3 border-b border-border-subtle align-middle">' + log.scan_time_ms + 'ms</td>' +
        '</tr>';

      const detailContent = isError && log.error_message
        ? '<div class="font-mono text-xs leading-relaxed text-error bg-error/10 border border-error/20 rounded-lg p-3 whitespace-pre-wrap break-words">' + log.error_message.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>'
        : '<div class="font-mono text-xs leading-relaxed text-text-secondary bg-surface border border-border-subtle rounded-lg p-3 whitespace-pre-wrap break-words">' + formatMaskedPreview(log.masked_content, entities) + '</div>';

      const detailRow =
        '<tr id="detail-' + logId + '" class="' + (isExpanded ? 'detail-row-visible' : 'hidden') + '">' +
          '<td colspan="8" class="p-0 bg-detail border-b border-border-subtle">' +
            '<div class="p-4 px-5 animate-slide-down">' + detailContent + '</div>' +
          '</td>' +
        '</tr>';

      return mainRow + detailRow;
    }).join('');
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  }
}

fetchStats();
fetchLogs();
setInterval(() => { fetchStats(); fetchLogs(); }, 5000);
			`,
		}}
	/>
);

export default DashboardPage;
