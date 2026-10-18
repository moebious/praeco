export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="es" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Praeco · Agentes que Pagan por la Empresa</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'monospace'],
          },
          colors: {
            praeco: {
              bg: '#0a0d14',
              surface: '#111726',
              border: '#1f293d',
              muted: '#64748b',
              emerald: '#10b981',
              amber: '#f59e0b',
              rose: '#f43f5e',
              indigo: '#6366f1',
            }
          }
        }
      }
    }
  </script>
  <style>
    body { background-color: #080b11; color: #f1f5f9; }
    .glass-card {
      background: rgba(17, 24, 39, 0.7);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .badge-paid { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-blocked { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
    .badge-pending { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
  </style>
</head>
<body class="min-h-screen flex flex-col font-sans selection:bg-indigo-500 selection:text-white">

  <!-- TOP HEADER -->
  <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-40">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
          P
        </div>
        <div>
          <div class="flex items-center space-x-2">
            <h1 class="text-lg font-bold tracking-tight text-white">PRAECO</h1>
            <span class="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">30X Hackathon · Reto Blinka</span>
          </div>
          <p class="text-xs text-slate-400">Agentes que pagan por la empresa · Gobernanza Financiera Determinista</p>
        </div>
      </div>

      <div class="flex items-center space-x-3">
        <div class="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-mono">
          <span class="h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
          <span>ENTORNO SIMULADO</span>
        </div>
        <button onclick="openRulesModal()" class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center space-x-1.5">
          <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg>
          <span>Reglas de Pago</span>
        </button>
        <button onclick="resetAndRunAll()" id="btn-run-all" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md shadow-emerald-500/20 transition flex items-center space-x-1.5">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <span>Ejecutar Lote (8 Casos)</span>
        </button>
      </div>
    </div>
  </header>

  <!-- LIVE METRICS & RULES STRIP -->
  <section class="border-b border-slate-800/60 bg-slate-900/40">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs">
      <div class="flex items-center space-x-6 text-slate-300">
        <div>
          <span class="text-slate-500 font-medium">Límite Autónomo:</span>
          <span id="metric-limit" class="font-mono font-semibold text-white ml-1.5">$2,500.00 USD</span>
        </div>
        <div>
          <span class="text-slate-500 font-medium">Tolerancia Recurrente:</span>
          <span id="metric-tol" class="font-mono font-semibold text-white ml-1.5">5.00%</span>
        </div>
        <div>
          <span class="text-slate-500 font-medium">Presupuesto Mensual:</span>
          <span id="metric-budget" class="font-mono font-semibold text-white ml-1.5">$5,000.00 USD</span>
        </div>
        <div>
          <span class="text-slate-500 font-medium">Comprometido:</span>
          <span id="metric-spent" class="font-mono font-semibold text-emerald-400 ml-1.5">$0.00 USD</span>
        </div>
      </div>
      <div class="flex items-center space-x-3 text-slate-400">
        <span class="inline-flex items-center"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5"></span>FX Fijo: 1 USD = 4,000 COP</span>
        <span class="inline-flex items-center"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5"></span>1 USD = 20 MXN</span>
        <button onclick="resetState()" class="text-slate-400 hover:text-white underline transition ml-2">Reiniciar</button>
      </div>
    </div>
  </section>

  <!-- MAIN BOARD: 3 COLUMNS -->
  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex-1 w-full">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">

      <!-- COLUMN 1: PAGÓ / AUTORIZÓ SIMULADO -->
      <div class="flex flex-col rounded-xl border border-emerald-500/20 bg-slate-900/30 p-4">
        <div class="flex items-center justify-between pb-3 border-b border-emerald-500/20 mb-4">
          <div class="flex items-center space-x-2">
            <span class="h-2.5 w-2.5 rounded-full bg-emerald-400"></span>
            <h2 class="font-semibold text-sm text-slate-100">PAGÓ (AUTORIZADO)</h2>
          </div>
          <span id="count-paid" class="text-xs font-mono font-medium px-2 py-0.5 rounded-full badge-paid">0</span>
        </div>
        <div id="col-paid" class="space-y-3 flex-1">
          <p class="text-xs text-slate-500 italic text-center py-8">No hay facturas autorizadas aún. Haz clic en "Ejecutar Lote".</p>
        </div>
      </div>

      <!-- COLUMN 2: FRENÓ -->
      <div class="flex flex-col rounded-xl border border-rose-500/20 bg-slate-900/30 p-4">
        <div class="flex items-center justify-between pb-3 border-b border-rose-500/20 mb-4">
          <div class="flex items-center space-x-2">
            <span class="h-2.5 w-2.5 rounded-full bg-rose-400"></span>
            <h2 class="font-semibold text-sm text-slate-100">FRENÓ (BLOQUEADO)</h2>
          </div>
          <span id="count-blocked" class="text-xs font-mono font-medium px-2 py-0.5 rounded-full badge-blocked">0</span>
        </div>
        <div id="col-blocked" class="space-y-3 flex-1">
          <p class="text-xs text-slate-500 italic text-center py-8">No hay facturas bloqueadas aún.</p>
        </div>
      </div>

      <!-- COLUMN 3: ESCALÓ / PENDIENTE DE APROBACIÓN -->
      <div class="flex flex-col rounded-xl border border-amber-500/20 bg-slate-900/30 p-4">
        <div class="flex items-center justify-between pb-3 border-b border-amber-500/20 mb-4">
          <div class="flex items-center space-x-2">
            <span class="h-2.5 w-2.5 rounded-full bg-amber-400"></span>
            <h2 class="font-semibold text-sm text-slate-100">ESCALÓ A PERSONA</h2>
          </div>
          <span id="count-pending" class="text-xs font-mono font-medium px-2 py-0.5 rounded-full badge-pending">0</span>
        </div>
        <div id="col-pending" class="space-y-3 flex-1">
          <p class="text-xs text-slate-500 italic text-center py-8">No hay facturas escaladas a revisión humana.</p>
        </div>
      </div>

    </div>
  </main>

  <!-- MODAL: AUDIT GATE INSPECTOR -->
  <div id="modal-audit" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full p-6 shadow-2xl relative">
      <button onclick="closeAuditModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>

      <div class="flex items-center space-x-3 mb-4">
        <div id="modal-audit-badge" class="px-2.5 py-1 rounded text-xs font-mono font-bold"></div>
        <h3 id="modal-audit-title" class="text-base font-bold text-white"></h3>
      </div>

      <p id="modal-audit-explanation" class="text-xs text-slate-300 bg-slate-800/60 p-3 rounded-lg border border-slate-700/60 mb-5 leading-relaxed font-sans"></p>

      <h4 class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Evaluación de 6 Gates Deterministas (Kernel L2)</h4>
      <div id="modal-audit-gates" class="space-y-2 mb-6"></div>

      <div class="border-t border-slate-800 pt-4 flex justify-between items-center text-xs text-slate-400 font-mono">
        <span id="modal-audit-key"></span>
        <button onclick="closeAuditModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition font-sans">Cerrar</button>
      </div>
    </div>
  </div>

  <!-- MODAL: RULES CONFIGURATION -->
  <div id="modal-rules" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 shadow-2xl relative">
      <button onclick="closeRulesModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
      <h3 class="text-base font-bold text-white mb-2">Configuración de Reglas de la Empresa</h3>
      <p class="text-xs text-slate-400 mb-5">El agente financiero nunca pagará fuera de estas reglas sin aprobación humana.</p>

      <form id="form-rules" onsubmit="saveRules(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Límite de Aprobación Autónoma (USD)</label>
          <input type="number" step="100" id="rule-max-auto" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono" required>
          <span class="text-[10px] text-slate-500">Montos superiores serán escalados automáticamente a FinanceAdmin.</span>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Tolerancia Máxima Recurrente (%)</label>
          <input type="number" step="0.5" id="rule-tol-pct" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono" required>
          <span class="text-[10px] text-slate-500">Incrementos sobre el valor recurrente base permitidos sin bloquear.</span>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">Presupuesto Mensual Asignado (USD)</label>
          <input type="number" step="500" id="rule-budget" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-mono" required>
        </div>
        <div class="pt-3 flex justify-end space-x-2">
          <button type="button" onclick="closeRulesModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition">Cancelar</button>
          <button type="submit" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg text-xs transition">Guardar Reglas</button>
        </div>
      </form>
    </div>
  </div>

  <!-- SCRIPT -->
  <script>
    let currentDecisions = [];
    let currentRules = {
      maxAutoApproveUsd: '2500.00',
      defaultRecurringTolerancePct: '5.00',
      budgetUsd: '5000.00',
      spentUsd: '0.00'
    };

    async function fetchRules() {
      try {
        const res = await fetch('/api/rules');
        if (res.ok) {
          currentRules = await res.json();
          renderRulesUI();
        }
      } catch (err) {
        console.error('Error fetching rules:', err);
      }
    }

    function renderRulesUI() {
      document.getElementById('metric-limit').textContent = '$' + Number(currentRules.maxAutoApproveUsd).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD';
      document.getElementById('metric-tol').textContent = currentRules.defaultRecurringTolerancePct + '%';
      document.getElementById('metric-budget').textContent = '$' + Number(currentRules.budgetUsd).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD';
      document.getElementById('metric-spent').textContent = '$' + Number(currentRules.spentUsd).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' USD';

      document.getElementById('rule-max-auto').value = currentRules.maxAutoApproveUsd;
      document.getElementById('rule-tol-pct').value = currentRules.defaultRecurringTolerancePct;
      document.getElementById('rule-budget').value = currentRules.budgetUsd;
    }

    async function resetAndRunAll() {
      const btn = document.getElementById('btn-run-all');
      btn.disabled = true;
      btn.innerHTML = '<span class="animate-spin mr-1">↻</span> Evaluando 8 casos...';
      try {
        const res = await fetch('/api/run-all', { method: 'POST' });
        const data = await res.json();
        currentDecisions = data.decisions;
        currentRules.spentUsd = data.spentUsd;
        renderBoard();
        renderRulesUI();
      } catch (err) {
        alert('Error ejecutando lote: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg><span>Ejecutar Lote (8 Casos)</span>';
      }
    }

    async function approveCase(approvalRequestId, scenarioId) {
      try {
        const res = await fetch('/api/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalRequestId, scenarioId })
        });
        const updatedRecord = await res.json();
        // Update decision list
        const idx = currentDecisions.findIndex(d => d.scenarioId === scenarioId);
        if (idx !== -1) {
          currentDecisions[idx] = { ...currentDecisions[idx], ...updatedRecord, outcome: 'AUTHORIZED_SIMULATED' };
        }
        await fetchRules();
        renderBoard();
      } catch (err) {
        alert('Error al aprobar: ' + err.message);
      }
    }

    async function rejectCase(approvalRequestId, scenarioId) {
      try {
        const res = await fetch('/api/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approvalRequestId, scenarioId })
        });
        const updatedRecord = await res.json();
        const idx = currentDecisions.findIndex(d => d.scenarioId === scenarioId);
        if (idx !== -1) {
          currentDecisions[idx] = { ...currentDecisions[idx], ...updatedRecord, outcome: 'BLOCKED' };
        }
        renderBoard();
      } catch (err) {
        alert('Error al rechazar: ' + err.message);
      }
    }

    async function resetState() {
      await fetch('/api/reset', { method: 'POST' });
      currentDecisions = [];
      await fetchRules();
      renderBoard();
    }

    function renderBoard() {
      const colPaid = document.getElementById('col-paid');
      const colBlocked = document.getElementById('col-blocked');
      const colPending = document.getElementById('col-pending');

      colPaid.innerHTML = '';
      colBlocked.innerHTML = '';
      colPending.innerHTML = '';

      let paidCount = 0, blockedCount = 0, pendingCount = 0;

      for (const d of currentDecisions) {
        const card = createCard(d);
        if (d.outcome === 'AUTHORIZED_SIMULATED') {
          colPaid.appendChild(card);
          paidCount++;
        } else if (d.outcome === 'BLOCKED') {
          colBlocked.appendChild(card);
          blockedCount++;
        } else if (d.outcome === 'PENDING_HUMAN_APPROVAL') {
          colPending.appendChild(card);
          pendingCount++;
        }
      }

      document.getElementById('count-paid').textContent = paidCount;
      document.getElementById('count-blocked').textContent = blockedCount;
      document.getElementById('count-pending').textContent = pendingCount;

      if (paidCount === 0) colPaid.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-8">Ninguna factura en esta columna.</p>';
      if (blockedCount === 0) colBlocked.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-8">Ninguna factura en esta columna.</p>';
      if (pendingCount === 0) colPending.innerHTML = '<p class="text-xs text-slate-500 italic text-center py-8">Ninguna factura en esta columna.</p>';
    }

    function createCard(item) {
      const div = document.createElement('div');
      div.className = 'glass-card rounded-lg p-3.5 border transition hover:border-slate-500/50 cursor-pointer flex flex-col justify-between';

      const isPaid = item.outcome === 'AUTHORIZED_SIMULATED';
      const isBlocked = item.outcome === 'BLOCKED';
      const isPending = item.outcome === 'PENDING_HUMAN_APPROVAL';

      const badgeClass = isPaid ? 'badge-paid' : isBlocked ? 'badge-blocked' : 'badge-pending';
      const badgeText = isPaid ? 'AUTORIZADO' : isBlocked ? 'FRENADO' : 'REQUIERE CFO';

      div.innerHTML = \`
        <div>
          <div class="flex items-start justify-between gap-2 mb-1.5">
            <div>
              <span class="text-[10px] font-mono font-medium text-slate-400">[\${item.scenarioId}]</span>
              <h3 class="text-xs font-semibold text-white leading-tight">\${item.title}</h3>
            </div>
            <span class="text-[10px] font-mono px-2 py-0.5 rounded font-bold uppercase \${badgeClass}">\${badgeText}</span>
          </div>

          <div class="text-xs font-mono font-bold text-slate-200 mb-1.5">
            \${item.claim}
          </div>

          <p class="text-[11px] text-slate-400 leading-relaxed mb-3 line-clamp-2">
            \${item.explanation}
          </p>
        </div>

        <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
          <span class="text-indigo-400 font-medium hover:underline" onclick="event.stopPropagation(); inspectAudit('\${item.scenarioId}')">Inspeccionar 6 Gates →</span>
          \${isPending && item.approvalRequestId ? \`
            <div class="flex space-x-1.5" onclick="event.stopPropagation()">
              <button onclick="approveCase('\${item.approvalRequestId}', '\${item.scenarioId}')" class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-[10px] shadow transition">✓ Aprobar</button>
              <button onclick="rejectCase('\${item.approvalRequestId}', '\${item.scenarioId}')" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 font-semibold text-[10px] transition">✕ Rechazar</button>
            </div>
          \` : ''}
        </div>
      \`;

      div.onclick = () => inspectAudit(item.scenarioId);
      return div;
    }

    function inspectAudit(scenarioId) {
      const item = currentDecisions.find(d => d.scenarioId === scenarioId);
      if (!item) return;

      document.getElementById('modal-audit-title').textContent = \`[\${item.scenarioId}] \${item.title}\`;
      document.getElementById('modal-audit-explanation').textContent = item.explanation;
      document.getElementById('modal-audit-key').textContent = \`Key: \${item.canonicalKey || 'N/A'}\`;

      const badge = document.getElementById('modal-audit-badge');
      if (item.outcome === 'AUTHORIZED_SIMULATED') {
        badge.className = 'px-2.5 py-1 rounded text-xs font-mono font-bold badge-paid';
        badge.textContent = 'PAGÓ (AUTORIZADO)';
      } else if (item.outcome === 'BLOCKED') {
        badge.className = 'px-2.5 py-1 rounded text-xs font-mono font-bold badge-blocked';
        badge.textContent = 'FRENÓ (BLOQUEADO)';
      } else {
        badge.className = 'px-2.5 py-1 rounded text-xs font-mono font-bold badge-pending';
        badge.textContent = 'ESCALÓ (PENDIENTE)';
      }

      const gatesContainer = document.getElementById('modal-audit-gates');
      gatesContainer.innerHTML = '';

      const gateNames = {
        G1: 'Evidencia e Integridad Documental (L1)',
        G2: 'Detección de Duplicados y Conflictos',
        G3: 'Beneficiario Permitido y Cuenta de Pago (HMAC)',
        G4: 'Validación de Contrato y Tolerancia',
        G5: 'Presupuesto Asignado del Periodo',
        G6: 'Umbral Autónomo vs Escalación Humana'
      };

      for (const g of (item.gateChecks || [])) {
        const isPass = g.status === 'PASS';
        const isReview = g.status === 'REVIEW_ELIGIBLE';
        const statusClass = isPass ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : isReview ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20';
        const icon = isPass ? '✓' : isReview ? '⏳' : '✕';

        const row = document.createElement('div');
        row.className = 'p-2.5 rounded-lg border border-slate-800 bg-slate-900/50 flex items-start justify-between text-xs';
        row.innerHTML = \`
          <div class="flex items-start space-x-2.5">
            <span class="font-mono font-bold \${statusClass} px-2 py-0.5 rounded border">\${g.gate}: \${icon}</span>
            <div>
              <div class="font-semibold text-slate-200">\${gateNames[g.gate] || g.gate}</div>
              <div class="text-[11px] text-slate-400 font-mono mt-0.5">\${g.code}</div>
              <div class="text-[11px] text-slate-300 mt-1 font-sans">\${g.explanation}</div>
            </div>
          </div>
        \`;
        gatesContainer.appendChild(row);
      }

      document.getElementById('modal-audit').classList.remove('hidden');
    }

    function closeAuditModal() {
      document.getElementById('modal-audit').classList.add('hidden');
    }

    function openRulesModal() {
      document.getElementById('modal-rules').classList.remove('hidden');
    }

    function closeRulesModal() {
      document.getElementById('modal-rules').classList.add('hidden');
    }

    async function saveRules(e) {
      e.preventDefault();
      const updated = {
        maxAutoApproveUsd: Number(document.getElementById('rule-max-auto').value).toFixed(2),
        defaultRecurringTolerancePct: Number(document.getElementById('rule-tol-pct').value).toFixed(2),
        budgetUsd: Number(document.getElementById('rule-budget').value).toFixed(2),
      };
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      });
      closeRulesModal();
      await fetchRules();
      if (currentDecisions.length > 0) {
        resetAndRunAll();
      }
    }

    // Auto-fetch rules and execute on load
    fetchRules().then(() => resetAndRunAll());
  </script>
</body>
</html>`;
}
