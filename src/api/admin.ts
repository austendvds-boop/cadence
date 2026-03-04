import type { Request, Response } from 'express';
import { getClientById, getClientStats, listAllClients, type Client } from '../db/queries';
import { logger } from '../utils/logger';

type AdminStatusFilter = 'all' | 'active' | 'trial' | 'canceled' | 'past_due';

const API_STATUS_FILTERS: readonly AdminStatusFilter[] = ['all', 'active', 'trial', 'canceled', 'past_due'];
const UI_STATUS_FILTERS: readonly Exclude<AdminStatusFilter, 'past_due'>[] = ['all', 'active', 'trial', 'canceled'];

const CSV_HEADERS = [
  'Business Name',
  'Owner Name',
  'Email',
  'Phone',
  'Status',
  'Cadence Number',
  'Signup Date',
] as const;

function escapeHtml(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      return `<tr>
        <td>${escapeHtml(client.businessName)}</td>
        <td>${escapeHtml(client.ownerName || '—')}</td>
        <td>${escapeHtml(client.ownerEmail)}</td>
        <td>${escapeHtml(client.ownerPhone || '—')}</td>
        <td>${escapeHtml(client.subscriptionStatus)}</td>
        <td>${escapeHtml(client.twilioNumber || '—')}</td>
        <td>${escapeHtml(formatDateOnly(client.createdAt))}</td>
        <td><a href="/admin/client/${escapeHtml(client.id)}">Open</a></td>
      </tr>`;
    }).join('');

    const exportHref = `/api/admin/export?status=${statusToQueryValue(status)}`;

    const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cadence Admin</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; color: #111; }
      .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 20px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 10px; background: #fafafa; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; border-bottom: 1px solid #e5e5e5; padding: 8px; font-size: 14px; }
      .filters { margin-bottom: 14px; display: flex; gap: 8px; align-items: end; }
      label { font-size: 13px; display: block; margin-bottom: 4px; }
      select, button, .button { padding: 8px 10px; border-radius: 6px; font-size: 14px; }
      button, .button { background: #111; color: #fff; border: 0; cursor: pointer; text-decoration: none; display: inline-block; }
      .muted { color: #666; font-size: 13px; margin-bottom: 10px; }
    </style>
  </head>
  <body>
    <h1>Admin Panel</h1>

    <div class="stats">
      <div class="card"><strong>Total clients</strong><div>${stats.totalClients}</div></div>
      <div class="card"><strong>Pending</strong><div>${stats.pendingClients}</div></div>
      <div class="card"><strong>Active</strong><div>${stats.activeClients}</div></div>
      <div class="card"><strong>Trial</strong><div>${stats.trialClients}</div></div>
      <div class="card"><strong>Past due</strong><div>${stats.pastDueClients}</div></div>
      <div class="card"><strong>Canceled</strong><div>${stats.canceledClients}</div></div>
      <div class="card"><strong>Total calls today</strong><div>${stats.totalCallsToday}</div></div>
    </div>

    <form class="filters" method="GET" action="/admin">
      <div>
        <label>Status</label>
        <select name="status">
          <option value="all" ${status === 'all' ? 'selected' : ''}>All</option>
          <option value="active" ${status === 'active' ? 'selected' : ''}>Active</option>
          <option value="trial" ${status === 'trial' ? 'selected' : ''}>Trial</option>
          <option value="canceled" ${status === 'canceled' ? 'selected' : ''}>Canceled</option>
        </select>
      </div>
      <button type="submit">Apply</button>
      <a class="button" href="${exportHref}">Export Clients</a>
    </form>

    <p class="muted">Showing ${clients.length} client(s) for filter: <strong>${escapeHtml(status)}</strong></p>

    <table>
      <thead>
        <tr><th>Business</th><th>Owner</th><th>Email</th><th>Phone</th><th>Status</th><th>Cadence Number</th><th>Signup Date</th><th></th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="8">No clients found.</td></tr>'}</tbody>
    </table>
  </body>
</html>`;

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

    const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin Client ${escapeHtml(client.businessName)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; color: #111; }
      label { display: block; margin: 10px 0 6px; font-size: 14px; }
      input, textarea, select, button { width: 100%; box-sizing: border-box; padding: 8px; font-size: 14px; }
      textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      button { background: #111; color: #fff; border: 0; border-radius: 6px; margin-top: 12px; cursor: pointer; }
      .status { margin-top: 10px; min-height: 16px; font-size: 13px; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <p><a href="/admin">← Back to admin</a></p>
    <h1>${escapeHtml(client.businessName)}</h1>
    <p>ID: <code>${escapeHtml(client.id)}</code></p>

    <form id="admin-client-form">
      <label>Business Name</label>
      <input name="business_name" value="${escapeHtml(client.businessName)}" />

      <label>Owner Name</label>
      <input name="owner_name" value="${escapeHtml(client.ownerName || '')}" />

      <label>Owner Email</label>
      <input name="owner_email" value="${escapeHtml(client.ownerEmail)}" />

      <label>Owner Phone</label>
      <input name="owner_phone" value="${escapeHtml(client.ownerPhone || '')}" />

      <label>Transfer Number</label>
      <input name="transfer_number" value="${escapeHtml(client.transferNumber || '')}" />

      <label>Area Code</label>
      <input name="area_code" value="${escapeHtml(client.areaCode || '')}" />

      <label>Cadence Number</label>
      <input name="twilio_number" value="${escapeHtml(client.twilioNumber || '')}" />

      <label>Cadence Number SID</label>
      <input name="twilio_number_sid" value="${escapeHtml(client.twilioNumberSid || '')}" />

      <label>Subscription Status</label>
      <select name="subscription_status">
        <option value="pending" ${client.subscriptionStatus === 'pending' ? 'selected' : ''}>pending</option>
        <option value="trial" ${client.subscriptionStatus === 'trial' ? 'selected' : ''}>trial</option>
        <option value="active" ${client.subscriptionStatus === 'active' ? 'selected' : ''}>active</option>
        <option value="past_due" ${client.subscriptionStatus === 'past_due' ? 'selected' : ''}>past_due</option>
        <option value="canceled" ${client.subscriptionStatus === 'canceled' ? 'selected' : ''}>canceled</option>
      </select>

      <label>Greeting</label>
      <textarea name="greeting">${escapeHtml(client.greeting || '')}</textarea>

      <label>Business Hours (JSON object)</label>
      <textarea name="hours">${escapeHtml(JSON.stringify(client.hours, null, 2))}</textarea>

      <label>FAQs (JSON array)</label>
      <textarea name="faqs">${escapeHtml(JSON.stringify(client.faqs, null, 2))}</textarea>

      <label>System Prompt</label>
      <textarea name="system_prompt">${escapeHtml(client.systemPrompt || '')}</textarea>

      <label>Allowed Tools (JSON array)</label>
      <textarea name="tools_allowed">${escapeHtml(JSON.stringify(client.toolsAllowed, null, 2))}</textarea>

      <button type="submit">Save Override</button>
      <div class="status" id="status"></div>
    </form>

    <script>
      const form = document.getElementById('admin-client-form');
      const status = document.getElementById('status');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
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
          hours: data.get('hours') || '{}',
          faqs: data.get('faqs') || '[]',
          system_prompt: data.get('system_prompt'),
          tools_allowed: data.get('tools_allowed') || '[]'
        };

        try {
          const response = await fetch('/api/admin/clients/${escapeHtml(client.id)}', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const body = await response.json();
          if (!response.ok) {
            status.textContent = body.error || 'Failed to update';
            return;
          }

          status.textContent = 'Saved.';
        } catch (error) {
          status.textContent = 'Failed to update';
        }
      });
    </script>
  </body>
</html>`;

    return res.status(200).type('html').send(page);
  } catch (err) {
    logger.error({ err, clientId: req.params.id }, 'GET /admin/client/:id failed');
    return res.status(500).send('Failed to load admin client page');
  }
}
