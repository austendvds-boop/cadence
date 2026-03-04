import type { Request, Response } from 'express';
import { getAuthenticatedClient } from './clients';
import { getCallLogs, getSubscriptionByClientId } from '../db/queries';
import { logger } from '../utils/logger';

function escapeHtml(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value: Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
}

function renderCallRows(callLogs: Awaited<ReturnType<typeof getCallLogs>>): string {
  if (callLogs.length === 0) {
    return '<tr><td colspan="4">No calls logged yet.</td></tr>';
  }

  return callLogs.map((call) => {
    return `<tr>
      <td>${escapeHtml(formatDate(call.createdAt))}</td>
      <td>${escapeHtml(call.callerNumber || 'Unknown')}</td>
      <td>${escapeHtml(call.durationSeconds == null ? '—' : `${call.durationSeconds}s`)}</td>
      <td>${escapeHtml(call.transcriptSummary || '—')}</td>
    </tr>`;
  }).join('');
}

export async function renderDashboard(req: Request, res: Response) {
  try {
    const client = await getAuthenticatedClient(req);
    if (!client) {
      return res.status(401).send('Unauthorized');
    }

    const [callLogs, subscription] = await Promise.all([
      getCallLogs(client.id, 50),
      getSubscriptionByClientId(client.id),
    ]);

    const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cadence Dashboard</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; color: #111; }
      h1, h2 { margin: 0 0 12px 0; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; background: #fafafa; }
      label { display: block; font-size: 14px; margin: 10px 0 6px; }
      input, textarea, button { width: 100%; box-sizing: border-box; font-size: 14px; padding: 8px; }
      textarea { min-height: 90px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      button { cursor: pointer; background: #111; color: #fff; border: 0; border-radius: 6px; margin-top: 12px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; }
      th, td { text-align: left; border-bottom: 1px solid #e5e5e5; padding: 8px; font-size: 13px; vertical-align: top; }
      .top-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
      .link-btn { display: inline-block; text-decoration: none; padding: 8px 12px; border-radius: 6px; background: #2563eb; color: #fff; }
      .status { font-size: 13px; margin-top: 8px; min-height: 16px; }
    </style>
  </head>
  <body>
    <h1>Client Dashboard</h1>
    <div class="grid">
      <div class="card"><strong>Business</strong><div>${escapeHtml(client.businessName)}</div></div>
      <div class="card"><strong>Cadence Number</strong><div>${escapeHtml(client.twilioNumber || 'Not provisioned')}</div></div>
      <div class="card"><strong>Subscription</strong><div>${escapeHtml(client.subscriptionStatus)}</div></div>
      <div class="card"><strong>Trial End</strong><div>${escapeHtml(formatDate(subscription?.trialEnd))}</div></div>
    </div>

    <div class="top-actions">
      <a class="link-btn" href="/api/clients/${escapeHtml(client.id)}/billing-portal">Manage Subscription</a>
    </div>

    <h2 style="margin-top:24px;">Editable Settings</h2>
    <form id="settings-form">
      <label>Transfer Number</label>
      <input name="transfer_number" value="${escapeHtml(client.transferNumber || '')}" />

      <label>Greeting</label>
      <textarea name="greeting">${escapeHtml(client.greeting || '')}</textarea>

      <label>Business Hours (JSON object)</label>
      <textarea name="hours">${escapeHtml(JSON.stringify(client.hours, null, 2))}</textarea>

      <label>FAQs (JSON array)</label>
      <textarea name="faqs">${escapeHtml(JSON.stringify(client.faqs, null, 2))}</textarea>

      <button type="submit">Save Settings</button>
      <div id="status" class="status"></div>
    </form>

    <h2 style="margin-top:28px;">Recent Call Log (Last 50)</h2>
    <table>
      <thead>
        <tr><th>Date</th><th>Caller</th><th>Duration</th><th>Summary</th></tr>
      </thead>
      <tbody>${renderCallRows(callLogs)}</tbody>
    </table>

    <script>
      const form = document.getElementById('settings-form');
      const status = document.getElementById('status');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.textContent = 'Saving...';

        const data = new FormData(form);
        const payload = {
          transfer_number: data.get('transfer_number') || null,
          greeting: data.get('greeting') || null,
          hours: data.get('hours') || '{}',
          faqs: data.get('faqs') || '[]'
        };

        try {
          const response = await fetch('/api/clients/${escapeHtml(client.id)}', {
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
    logger.error({ err }, 'GET /dashboard failed');
    return res.status(500).send('Failed to load dashboard');
  }
}
