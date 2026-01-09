import type { FC } from "hono/jsx";

const DashboardPage: FC = () => {
	return (
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>PasteGuard Dashboard</title>
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link
					rel="preconnect"
					href="https://fonts.gstatic.com"
					crossOrigin="anonymous"
				/>
				<link
					href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600;700&display=swap"
					rel="stylesheet"
				/>
				<link rel="stylesheet" href="/dashboard/tailwind.css" />
				<style
					// biome-ignore lint/security/noDangerouslySetInnerHtml: Custom CSS
					dangerouslySetInnerHTML={{
						__html: `
							:root {
								--page: #f8f7f4;
								--surface: #ffffff;
								--elevated: #fafaf9;
								--subtle: #f3f2ef;
								--detail: #fdfcfa;
								--border: #e5e3df;
								--border-subtle: #eeece8;
								--text-primary: #1a1917;
								--text-secondary: #5c5a56;
								--text-muted: #9c9a96;
								--amber: #d97706;
								--amber-light: #fef3c7;
								--blue: #2563eb;
								--blue-light: #dbeafe;
								--green: #059669;
								--green-light: #d1fae5;
								--teal: #0d9488;
								--teal-light: #ccfbf1;
							}
							body {
								font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, sans-serif;
								background: var(--page);
								color: var(--text-primary);
							}
							.font-mono { font-family: 'DM Mono', 'SF Mono', monospace; }
							.bg-page { background: var(--page); }
							.bg-surface { background: var(--surface); }
							.bg-elevated { background: var(--elevated); }
							.bg-subtle { background: var(--subtle); }
							.bg-detail { background: var(--detail); }
							.bg-amber { background: var(--amber); }
							.bg-amber-light { background: var(--amber-light); }
							.bg-amber\\/10 { background: rgba(217, 119, 6, 0.1); }
							.bg-blue { background: var(--blue); }
							.bg-blue\\/10 { background: rgba(37, 99, 235, 0.1); }
							.bg-green { background: var(--green); }
							.bg-green\\/10 { background: rgba(5, 150, 105, 0.1); }
							.bg-teal { background: var(--teal); }
							.border-border { border-color: var(--border); }
							.border-border-subtle { border-color: var(--border-subtle); }
							.border-amber\\/20 { border-color: rgba(217, 119, 6, 0.2); }
							.border-green\\/20 { border-color: rgba(5, 150, 105, 0.2); }
							.text-text-primary { color: var(--text-primary); }
							.text-text-secondary { color: var(--text-secondary); }
							.text-text-muted { color: var(--text-muted); }
							.text-amber { color: var(--amber); }
							.text-blue { color: var(--blue); }
							.text-green { color: var(--green); }
							.text-teal { color: var(--teal); }
							@keyframes pulse {
								0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.3); }
								50% { opacity: 0.8; box-shadow: 0 0 0 4px rgba(5, 150, 105, 0); }
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
							.animate-pulse-dot { animation: pulse 2s ease-in-out infinite; }
							.animate-spin { animation: spin 0.8s linear infinite; }
							.animate-fade-in { animation: fadeIn 0.35s ease-out backwards; }
							.animate-slide-down { animation: slideDown 0.25s ease-out; }
							.route-only { display: none; }
							[data-mode="route"] .route-only { display: block; }
							[data-mode="route"] th.route-only,
							[data-mode="route"] td.route-only { display: table-cell; }
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
		<div class="flex items-center gap-2.5">
			<div class="w-9 h-9 bg-gradient-to-br from-slate-50 to-slate-200 border border-border rounded-lg flex items-center justify-center text-lg shadow-sm">
				🛡️
			</div>
			<div class="text-xl font-bold tracking-tight text-text-primary">
				Paste<span class="text-amber">Guard</span>
			</div>
		</div>
		<div class="flex items-center gap-4">
			<span
				id="mode-badge"
				class="inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[0.7rem] font-medium tracking-wide uppercase"
			>
				—
			</span>
			<div class="flex items-center gap-2 px-3 py-1.5 bg-surface border border-border rounded-full text-xs text-text-secondary shadow-sm">
				<div class="w-[7px] h-[7px] bg-green rounded-full animate-pulse-dot" />
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
			accent="amber"
		/>
		<StatCard label="Avg PII Scan" valueId="avg-scan" accent="teal" />
		<StatCard label="Requests/Hour" valueId="requests-hour" />
		<StatCard
			id="upstream-card"
			label="Upstream"
			valueId="upstream-requests"
			accent="blue"
			routeOnly
		/>
		<StatCard
			id="local-card"
			label="Local"
			valueId="local-requests"
			accent="green"
			routeOnly
		/>
	</div>
);

const StatCard: FC<{
	id?: string;
	label: string;
	labelId?: string;
	valueId: string;
	accent?: "amber" | "blue" | "green" | "teal";
	routeOnly?: boolean;
}> = ({ id, label, labelId, valueId, accent, routeOnly }) => {
	const accentClass = accent
		? {
				amber: "text-amber",
				blue: "text-blue",
				green: "text-green",
				teal: "text-teal",
			}[accent]
		: "";

	return (
		<div
			id={id}
			class={`bg-surface border border-border-subtle rounded-xl p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 animate-fade-in ${routeOnly ? "route-only" : ""}`}
		>
			<div
				id={labelId}
				class="text-[0.7rem] font-medium uppercase tracking-widest text-text-muted mb-2"
			>
				{label}
			</div>
			<div
				id={valueId}
				class={`text-3xl font-bold tabular-nums tracking-tight ${accentClass}`}
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
				class="flex h-10 rounded-lg overflow-hidden bg-subtle"
			>
				<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-blue min-w-[48px] transition-all duration-400 w-1/2">
					50%
				</div>
				<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-green min-w-[48px] transition-all duration-400 w-1/2">
					50%
				</div>
			</div>
			<div class="flex gap-6 mt-4">
				<div class="flex items-center gap-2 text-xs text-text-secondary">
					<div class="w-2.5 h-2.5 rounded bg-blue" />
					<span>Upstream</span>
				</div>
				<div class="flex items-center gap-2 text-xs text-text-secondary">
					<div class="w-2.5 h-2.5 rounded bg-green" />
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
				<div class="text-center py-10 text-text-muted">
					<div class="text-2xl mb-3 opacity-40">📊</div>
					<div class="text-sm">No PII detected yet</div>
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
								Scan Time
							</th>
						</tr>
					</thead>
					<tbody id="logs-body">
						<tr>
							<td colSpan={6}>
								<div class="flex justify-center items-center p-10 text-text-muted text-sm">
									<div class="w-[18px] h-[18px] border-2 border-border border-t-amber rounded-full animate-spin mr-2.5" />
									Loading...
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
      ? 'inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[0.7rem] font-medium tracking-wide uppercase bg-green/10 text-green border border-green/20'
      : 'inline-flex items-center px-3 py-1.5 rounded-lg font-mono text-[0.7rem] font-medium tracking-wide uppercase bg-amber/10 text-amber border border-amber/20';

    const piiLabel = document.getElementById('pii-label');
    if (data.mode === 'mask') {
      piiLabel.textContent = 'Masked';
      document.getElementById('pii-requests').textContent = data.pii_requests.toLocaleString() + ' (' + data.pii_percentage + '%)';
    } else {
      piiLabel.textContent = 'Routed Local';
      document.getElementById('pii-requests').textContent = data.local_requests.toLocaleString();
    }

    if (data.mode === 'route') {
      document.getElementById('upstream-requests').textContent = data.upstream_requests.toLocaleString();
      document.getElementById('local-requests').textContent = data.local_requests.toLocaleString();

      const total = data.upstream_requests + data.local_requests;
      const upstreamPct = total > 0 ? Math.round((data.upstream_requests / total) * 100) : 50;
      const localPct = 100 - upstreamPct;

      document.getElementById('provider-split').innerHTML =
        '<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-blue min-w-[48px] transition-all duration-400" style="width:' + Math.max(upstreamPct, 10) + '%">' + upstreamPct + '%</div>' +
        '<div class="flex items-center justify-center font-mono text-[0.7rem] font-medium text-white bg-green min-w-[48px] transition-all duration-400" style="width:' + Math.max(localPct, 10) + '%">' + localPct + '%</div>';
    }

    const chartEl = document.getElementById('entity-chart');
    if (data.entity_breakdown && data.entity_breakdown.length > 0) {
      const maxCount = Math.max(...data.entity_breakdown.map(e => e.count));
      chartEl.innerHTML = data.entity_breakdown.slice(0, 6).map(e =>
        '<div class="grid grid-cols-[100px_1fr_40px] items-center gap-3">' +
          '<div class="font-mono text-[0.65rem] text-text-secondary truncate">' + e.entity + '</div>' +
          '<div class="h-1.5 bg-subtle rounded overflow-hidden">' +
            '<div class="h-full bg-gradient-to-r from-amber to-amber-700 rounded transition-all duration-400" style="width:' + ((e.count / maxCount) * 100) + '%"></div>' +
          '</div>' +
          '<div class="font-mono text-[0.7rem] font-medium text-right text-text-primary">' + e.count + '</div>' +
        '</div>'
      ).join('');
    } else {
      chartEl.innerHTML = '<div class="text-center py-10 text-text-muted"><div class="text-2xl mb-3 opacity-40">📊</div><div class="text-sm">No PII detected yet</div></div>';
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
    el.classList.remove('rotate-90', 'bg-amber/10', 'text-amber');
    el.classList.add('bg-subtle', 'text-text-muted');
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
        arrow.classList.remove('bg-subtle', 'text-text-muted');
        arrow.classList.add('rotate-90', 'bg-amber/10', 'text-amber');
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
      .replace(/&lt;([A-Z_]+_\\d+)&gt;/g, '<span class="bg-amber-light text-amber px-1 py-0.5 rounded font-medium">&lt;$1&gt;</span>');
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
    '<div class="flex items-center gap-2.5 text-xs p-2 px-3 bg-surface border border-border-subtle rounded-lg">' +
      '<span class="font-mono text-[0.65rem] font-medium px-1.5 py-0.5 bg-amber/10 text-amber rounded">' + type + '</span>' +
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
      tbody.innerHTML = '<tr><td colspan="6"><div class="text-center py-10 text-text-muted"><div class="text-2xl mb-3 opacity-40">📋</div><div class="text-sm">No requests yet</div></div></td></tr>';
      return;
    }

    tbody.innerHTML = data.logs.map((log, index) => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const entities = log.entities ? log.entities.split(',').filter(e => e.trim()) : [];
      const lang = log.language || 'en';
      const detectedLang = log.detected_language;

      const formatLang = (code) => code ? code.toUpperCase() : lang.toUpperCase();

      // Show original→fallback when fallback was used (e.g. FR→EN)
      const langDisplay = log.language_fallback && detectedLang
        ? '<span class="text-amber" title="Language not supported, fallback used">' + formatLang(detectedLang) + '</span><span class="text-text-muted text-[0.5rem] mx-0.5">→</span><span>' + lang.toUpperCase() + '</span>'
        : lang.toUpperCase();
      const logId = log.id || index;
      const isExpanded = expandedRowId === logId;

      const mainRow =
        '<tr id="log-' + logId + '" class="cursor-pointer transition-colors hover:bg-elevated ' + (isExpanded ? 'log-row-expanded bg-elevated' : '') + '" onclick="toggleRow(' + logId + ')">' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            '<span id="arrow-' + logId + '" class="arrow-icon inline-flex items-center justify-center w-[18px] h-[18px] mr-2 rounded bg-subtle text-text-muted text-[0.65rem] transition-transform ' + (isExpanded ? 'rotate-90 bg-amber/10 text-amber' : '') + '">▶</span>' +
            '<span class="font-mono text-[0.7rem] text-text-secondary">' + time + '</span>' +
          '</td>' +
          '<td class="route-only text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            '<span class="inline-flex items-center px-2 py-1 rounded font-mono text-[0.6rem] font-medium uppercase tracking-wide ' +
              (log.provider === 'upstream' ? 'bg-blue/10 text-blue' : 'bg-green/10 text-green') + '">' + log.provider + '</span>' +
          '</td>' +
          '<td class="font-mono text-[0.7rem] text-text-secondary px-4 py-3 border-b border-border-subtle align-middle">' + log.model + '</td>' +
          '<td class="font-mono text-[0.65rem] font-medium px-4 py-3 border-b border-border-subtle align-middle">' + langDisplay + '</td>' +
          '<td class="text-sm px-4 py-3 border-b border-border-subtle align-middle">' +
            (entities.length > 0
              ? '<div class="flex flex-wrap gap-1">' + entities.map(e => '<span class="font-mono text-[0.55rem] px-1.5 py-0.5 bg-subtle border border-border rounded text-text-secondary">' + e.trim() + '</span>').join('') + '</div>'
              : '<span class="text-text-muted">—</span>') +
          '</td>' +
          '<td class="font-mono text-[0.7rem] text-teal px-4 py-3 border-b border-border-subtle align-middle">' + log.scan_time_ms + 'ms</td>' +
        '</tr>';

      const detailRow =
        '<tr id="detail-' + logId + '" class="' + (isExpanded ? 'detail-row-visible' : 'hidden') + '">' +
          '<td colspan="6" class="p-0 bg-detail border-b border-border-subtle">' +
            '<div class="p-4 px-5 animate-slide-down">' +
              '<div class="font-mono text-xs leading-relaxed text-text-secondary bg-surface border border-border-subtle rounded-lg p-3 whitespace-pre-wrap break-words">' + formatMaskedPreview(log.masked_content, entities) + '</div>' +
            '</div>' +
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
