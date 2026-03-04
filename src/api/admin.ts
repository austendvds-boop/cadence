import type { Request, Response } from 'express';
import { getCallLogsPage, getClientById, getClientStats, listAllClients, type Client } from '../db/queries';
import { logger } from '../utils/logger';
import { escapeHtml, renderAppShell, statusBadgeClass } from './ui-shell';

type AdminStatusFilter = 'all' | 'pending' | 'active' | 'trial' | 'canceled' | 'past_due';

const API_STATUS_FILTERS: readonly AdminStatusFilter[] = ['all', 'pending', 'active', 'trial', 'canceled', 'past_due'];
const UI_STATUS_FILTERS: readonly AdminStatusFilter[] = ['all', 'pending', 'active', 'trial', 'past_due', 'canceled'];

const CSV_HEADERS = [
  'Business Name',
  'Owner Name',
  'Email',
  'Phone',
  'Status',
  'Cadence Number',
  'Signup Date',
] as const;

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseStatusFilter(value: unknown, allowedFilters: readonly AdminStatusFilter[]): AdminStatusFilter {
  const normalized = asTrimmedString(value).toLowerCase();
  if (!normalized) {
    return 'all';
  }

  for (const candidate of allowedFilters) {
    if (normalized === candidate) {
      return candidate;
    }
  }

  return 'all';
}

function toAdminClientSummary(client: Client) {
  return {
    id: client.id,
    business_name: client.businessName,
    owner_name: client.ownerName,
    owner_email: client.ownerEmail,
    owner_phone: client.ownerPhone,
    subscription_status: client.subscriptionStatus,
    twilio_number: client.twilioNumber,
    created_at: client.createdAt,
    updated_at: client.updatedAt,
  };
}

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  if (!text) return '';

  const escaped = text.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
}

function toClientsCsv(clients: Client[]): string {
  const lines: string[] = [CSV_HEADERS.join(',')];

  for (const client of clients) {
    const row = [
      client.businessName,
      client.ownerName ?? '',
      client.ownerEmail,
      client.ownerPhone ?? '',
      client.subscriptionStatus,
      client.twilioNumber ?? '',
      formatDateOnly(client.createdAt),
    ];

    lines.push(row.map(csvEscape).join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

function statusToQueryValue(status: AdminStatusFilter): string {
  return encodeURIComponent(status);
}

function renderStatusOptions(selectedStatus: AdminStatusFilter): string {
  return UI_STATUS_FILTERS.map((status) => {
    const label = status === 'all' ? 'All' : status;
    return `<option value="${status}" ${selectedStatus === status ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

export async function handleAdminClientsList(req: Request, res: Response) {
  try {
    const status = parseStatusFilter(req.query.status, API_STATUS_FILTERS);
    const clients = await listAllClients({ status });

    return res.status(200).json(clients.map(toAdminClientSummary));
  } catch (err) {
    logger.error({ err }, 'GET /api/admin/clients failed');
    return res.status(500).json({ error: 'Failed to load clients' });
  }
}

export async function handleAdminClientsExport(req: Request, res: Response) {
  try {
    const status = parseStatusFilter(req.query.status, API_STATUS_FILTERS);
    const clients = await listAllClients({ status });
    const csv = toClientsCsv(clients);
    const today = formatDateOnly(new Date());
    const filename = `cadence-clients-${today}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    return res.status(200).send(csv);
  } catch (err) {
    logger.error({ err }, 'GET /api/admin/export failed');
    return res.status(500).json({ error: 'Failed to export clients' });
  }
}

export async function renderAdmin(req: Request, res: Response) {
  try {
    const status = parseStatusFilter(req.query.status, UI_STATUS_FILTERS);

    const [clients, stats] = await Promise.all([
      listAllClients({ status }),
      getClientStats(),
    ]);

    const rows = clients.map((client) => {
      return `<tr class="table-row-link" tabindex="0" data-href="/admin/client/${encodeURIComponent(client.id)}">
        <td>${escapeHtml(client.businessName)}</td>
        <td>${escapeHtml(client.ownerName || '—')}</td>
        <td>${escapeHtml(client.ownerEmail)}</td>
        <td><span class="${statusBadgeClass(client.subscriptionStatus)}">${escapeHtml(client.subscriptionStatus)}</span></td>
        <td>${escapeHtml(client.twilioNumber || '—')}</td>
        <td>${escapeHtml(formatDateOnly(client.createdAt))}</td>
      </tr>`;
    }).join('');

    const exportHref = `/api/admin/export?status=${statusToQueryValue(status)}`;

    const statsSection = `<section class="grid-metrics">
      <article class="card-surface metric-card">
        <p class="metric-label">Total clients</p>
        <p class="metric-value">${stats.totalClients}</p>
      </article>
      <article class="card-surface metric-card">
        <p class="metric-label">Active</p>
        <p class="metric-value"><span class="badge badge-active">${stats.activeClients}</span></p>
      </article>
      <article class="card-surface metric-card">
        <p class="metric-label">Trial</p>
        <p class="metric-value"><span class="badge badge-trial">${stats.trialClients}</span></p>
      </article>
      <article class="card-surface metric-card">
        <p class="metric-label">Past due</p>
        <p class="metric-value"><span class="badge badge-past-due">${stats.pastDueClients}</span></p>
      </article>
      <article class="card-surface metric-card">
        <p class="metric-label">Canceled</p>
        <p class="metric-value"><span class="badge badge-canceled">${stats.canceledClients}</span></p>
      </article>
    </section>`;

    const clientsSection = `<section class="card-surface panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Client roster</h2>
          <p class="panel-subtitle">Click any row to open /admin/client/:id</p>
        </div>
      </div>

      <form class="form-actions" method="GET" action="/admin" style="margin-bottom: 12px;">
        <div>
          <label for="status-filter">Status filter</label>
          <select id="status-filter" class="select" name="status" style="min-width: 180px;">
            ${renderStatusOptions(status)}
          </select>
        </div>
        <button class="btn btn-secondary" type="submit">Apply</button>
        <a class="btn btn-primary" href="${exportHref}">Export CSV</a>
      </form>

      <p class="helper">Showing ${clients.length} client(s) for <strong>${escapeHtml(status)}</strong>.</p>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Business Name</th>
              <th>Owner</th>
              <th>Email</th>
              <th>Status</th>
              <th>Cadence Number</th>
              <th>Signup Date</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6">No clients found for this filter.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <script>
      const logoutLink = document.getElementById('logout-link');

      document.querySelectorAll('[data-href]').forEach((row) => {
        row.addEventListener('click', () => {
          const target = row.getAttribute('data-href');
          if (target) window.location.href = target;
        });

        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            const target = row.getAttribute('data-href');
            if (target) window.location.href = target;
          }
        });
      });

      if (logoutLink) {
        logoutLink.addEventListener('click', (event) => {
          event.preventDefault();
          document.cookie = 'cadence_token=; Max-Age=0; path=/';
          window.location.href = '/login';
        });
      }
    </script>`;

    const page = renderAppShell({
      title: 'Cadence Admin',
      headerTitle: 'Cadence Admin',
      headerSubtitle: 'Operations and client controls',
      headerActionsHtml: `
        <a class="btn btn-ghost" href="/dashboard">Back to Dashboard</a>
        <a class="btn btn-ghost" href="/login" id="logout-link">Logout</a>
      `,
      contentHtml: `${statsSection}${clientsSection}`,
    });

    return res.status(200).type('html').send(page);
  } catch (err) {
    logger.error({ err }, 'GET /admin failed');
    return res.status(500).send('Failed to load admin panel');
  }
}

export async function renderAdminClient(req: Request, res: Response) {
  try {
    const clientId = asTrimmedString(req.params.id);
    if (!clientId) {
      return res.status(400).send('Client id is required');
    }

    const client = await getClientById(clientId);
    if (!client) {
      return res.status(404).send('Client not found');
    }

    const initialCalls = await getCallLogsPage(client.id, { limit: 15, offset: 0 });

    const initialCallRows = initialCalls.length
      ? initialCalls.map((call) => `<tr>
          <td>${escapeHtml(formatDateTime(call.createdAt))}</td>
          <td>${escapeHtml(call.callerNumber || 'Unknown')}</td>
          <td>${escapeHtml(call.durationSeconds == null ? '—' : `${call.durationSeconds}s`)}</td>
          <td>${escapeHtml(call.transcriptSummary || '—')}</td>
        </tr>`).join('')
      : '<tr><td colspan="4">No calls yet — your AI receptionist is ready and waiting!</td></tr>';

    const contentHtml = `<section class="card-surface panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Client details</h2>
          <p class="panel-subtitle">ID: <code>${escapeHtml(client.id)}</code></p>
        </div>
      </div>

      <form id="admin-client-form" class="panel-stack">
        <article class="card-surface panel">
          <h3 class="panel-title" style="font-size: 0.96rem; margin-bottom: 12px;">Business & owner</h3>

          <div class="form-row"><label for="business_name">Business name</label><input id="business_name" name="business_name" type="text" value="${escapeHtml(client.businessName)}" /></div>
          <div class="form-row"><label for="owner_name">Owner</label><input id="owner_name" name="owner_name" type="text" value="${escapeHtml(client.ownerName || '')}" /></div>
          <div class="form-row"><label for="owner_email">Email</label><input id="owner_email" name="owner_email" type="text" value="${escapeHtml(client.ownerEmail)}" /></div>
          <div class="form-row"><label for="owner_phone">Phone</label><input id="owner_phone" name="owner_phone" type="text" value="${escapeHtml(client.ownerPhone || '')}" /></div>
          <div class="form-row"><label for="subscription_status">Status</label>
            <select id="subscription_status" name="subscription_status">
              <option value="pending" ${client.subscriptionStatus === 'pending' ? 'selected' : ''}>pending</option>
              <option value="trial" ${client.subscriptionStatus === 'trial' ? 'selected' : ''}>trial</option>
              <option value="active" ${client.subscriptionStatus === 'active' ? 'selected' : ''}>active</option>
              <option value="past_due" ${client.subscriptionStatus === 'past_due' ? 'selected' : ''}>past_due</option>
              <option value="canceled" ${client.subscriptionStatus === 'canceled' ? 'selected' : ''}>canceled</option>
            </select>
          </div>
        </article>

        <article class="card-surface panel">
          <h3 class="panel-title" style="font-size: 0.96rem; margin-bottom: 12px;">Voice routing & greeting</h3>

          <div class="form-row"><label for="transfer_number">Transfer number</label><input id="transfer_number" name="transfer_number" type="text" value="${escapeHtml(client.transferNumber || '')}" /></div>
          <div class="form-row"><label for="area_code">Area code</label><input id="area_code" name="area_code" type="text" value="${escapeHtml(client.areaCode || '')}" /></div>
          <div class="form-row"><label for="twilio_number">Cadence number</label><input id="twilio_number" name="twilio_number" type="text" value="${escapeHtml(client.twilioNumber || '')}" /></div>
          <div class="form-row"><label for="twilio_number_sid">Cadence number SID</label><input id="twilio_number_sid" name="twilio_number_sid" type="text" value="${escapeHtml(client.twilioNumberSid || '')}" /></div>
          <div class="form-row"><label for="greeting">Greeting</label><textarea id="greeting" name="greeting">${escapeHtml(client.greeting || '')}</textarea></div>
        </article>

        <article class="card-surface panel">
          <h3 class="panel-title" style="font-size: 0.96rem; margin-bottom: 12px;">Override controls</h3>

          <div class="form-row"><label for="tts_model">TTS model</label><input id="tts_model" name="tts_model" type="text" value="${escapeHtml(client.ttsModel)}" /></div>
          <div class="form-row"><label for="stt_model">STT model</label><input id="stt_model" name="stt_model" type="text" value="${escapeHtml(client.sttModel)}" /></div>
          <div class="form-row"><label for="llm_model">LLM model</label><input id="llm_model" name="llm_model" type="text" value="${escapeHtml(client.llmModel)}" /></div>
          <div class="form-row"><label for="system_prompt">System prompt</label><textarea id="system_prompt" name="system_prompt">${escapeHtml(client.systemPrompt || '')}</textarea></div>
          <div class="form-row"><label for="tools_allowed">Allowed tools (JSON array)</label><textarea id="tools_allowed" name="tools_allowed">${escapeHtml(JSON.stringify(client.toolsAllowed, null, 2))}</textarea></div>
        </article>

        <article class="card-surface panel">
          <h3 class="panel-title" style="font-size: 0.96rem; margin-bottom: 12px;">Business data</h3>

          <div class="form-row"><label for="hours">Business hours (JSON object)</label><textarea id="hours" name="hours">${escapeHtml(JSON.stringify(client.hours, null, 2))}</textarea></div>
          <div class="form-row"><label for="faqs">FAQs (JSON array)</label><textarea id="faqs" name="faqs">${escapeHtml(JSON.stringify(client.faqs, null, 2))}</textarea></div>
        </article>

        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Save overrides</button>
          <p class="form-feedback" id="status"></p>
        </div>
      </form>
    </section>

    <section class="card-surface panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Client call log</h2>
          <p class="panel-subtitle">Recent calls tied to this client.</p>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>Date</th><th>Caller Number</th><th>Duration</th><th>Summary</th></tr>
          </thead>
          <tbody id="client-call-log-body">${initialCallRows}</tbody>
        </table>
      </div>

      <div class="form-actions" style="margin-top: 12px;">
        <button class="btn btn-secondary" id="load-more-calls" type="button">Load more</button>
      </div>
    </section>

    <script>
      const form = document.getElementById('admin-client-form');
      const status = document.getElementById('status');
      const callLogBody = document.getElementById('client-call-log-body');
      const loadMoreCallsButton = document.getElementById('load-more-calls');
      const logoutLink = document.getElementById('logout-link');
      const clientId = ${JSON.stringify(client.id)};

      let callOffset = ${initialCalls.length};
      const callLimit = 15;
      let hasMore = ${initialCalls.length === 15 ? 'true' : 'false'};
      let isLoadingCalls = false;

      function escapeClient(value) {
        const text = value == null ? '' : String(value);
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatDateClient(value) {
        if (!value) return '—';
        try {
          return new Date(value).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
        } catch {
          return String(value);
        }
      }

      function callRow(call) {
        return '<tr>' +
          '<td>' + escapeClient(formatDateClient(call.created_at)) + '</td>' +
          '<td>' + escapeClient(call.caller_number || 'Unknown') + '</td>' +
          '<td>' + escapeClient(call.duration_seconds == null ? '—' : call.duration_seconds + 's') + '</td>' +
          '<td>' + escapeClient(call.transcript_summary || '—') + '</td>' +
          '</tr>';
      }

      function updateLoadMoreVisibility() {
        if (hasMore) {
          loadMoreCallsButton.classList.remove('hidden');
        } else {
          loadMoreCallsButton.classList.add('hidden');
        }
      }

      async function loadMoreCalls() {
        if (!hasMore || isLoadingCalls) return;
        isLoadingCalls = true;

        try {
          const response = await fetch('/api/clients/' + encodeURIComponent(clientId) + '/calls?limit=' + callLimit + '&offset=' + callOffset, {
            headers: { Accept: 'application/json' }
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || 'Failed to load calls');
          }

          const calls = Array.isArray(payload.calls) ? payload.calls : [];
          if (calls.length === 0) {
            hasMore = false;
            updateLoadMoreVisibility();
            return;
          }

          callLogBody.insertAdjacentHTML('beforeend', calls.map(callRow).join(''));
          hasMore = Boolean(payload.pagination && payload.pagination.has_more);
          callOffset = Number(payload.pagination && payload.pagination.next_offset != null
            ? payload.pagination.next_offset
            : callOffset + calls.length);
          updateLoadMoreVisibility();
        } catch {
          hasMore = false;
          updateLoadMoreVisibility();
        } finally {
          isLoadingCalls = false;
        }
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.className = 'form-feedback';
        status.textContent = 'Saving...';

        const data = new FormData(form);
        const payload = {
          business_name: data.get('business_name'),
          owner_name: data.get('owner_name'),
          owner_email: data.get('owner_email'),
          owner_phone: data.get('owner_phone'),
          transfer_number: data.get('transfer_number'),
          area_code: data.get('area_code'),
          twilio_number: data.get('twilio_number'),
          twilio_number_sid: data.get('twilio_number_sid'),
          subscription_status: data.get('subscription_status'),
          greeting: data.get('greeting'),
          tts_model: data.get('tts_model'),
          stt_model: data.get('stt_model'),
          llm_model: data.get('llm_model'),
          system_prompt: data.get('system_prompt'),
          tools_allowed: data.get('tools_allowed') || '[]',
          hours: data.get('hours') || '{}',
          faqs: data.get('faqs') || '[]'
        };

        try {
          const response = await fetch('/api/admin/clients/' + encodeURIComponent(clientId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(body.error || 'Failed to save');
          }

          status.className = 'form-feedback feedback-ok';
          status.textContent = 'Saved.';
        } catch (error) {
          status.className = 'form-feedback feedback-error';
          status.textContent = error instanceof Error ? error.message : 'Failed to save';
        }
      });

      loadMoreCallsButton.addEventListener('click', () => {
        loadMoreCalls();
      });

      if (logoutLink) {
        logoutLink.addEventListener('click', (event) => {
          event.preventDefault();
          document.cookie = 'cadence_token=; Max-Age=0; path=/';
          window.location.href = '/login';
        });
      }

      updateLoadMoreVisibility();
    </script>`;

    const page = renderAppShell({
      title: `Cadence Admin — ${client.businessName}`,
      headerTitle: 'Cadence Admin',
      headerSubtitle: client.businessName,
      headerActionsHtml: `
        <a class="btn btn-ghost" href="/dashboard">Back to Dashboard</a>
        <a class="btn btn-ghost" href="/admin">Back to Client List</a>
        <a class="btn btn-ghost" href="/login" id="logout-link">Logout</a>
      `,
      contentHtml,
    });

    return res.status(200).type('html').send(page);
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'GET /admin/client/:id failed');
    return res.status(500).send('Failed to load admin client page');
  }
}
