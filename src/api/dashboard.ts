import type { Request, Response } from 'express';
import { getAuthenticatedClient } from './clients';
import { getCallLogsPage, getSubscriptionByClientId } from '../db/queries';
import { logger } from '../utils/logger';
import { escapeHtml, renderAppShell, statusBadgeClass } from './ui-shell';

function formatDateTime(value: Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
}

function formatDateOnly(value: Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-US', { timeZone: 'America/Phoenix' });
}

function countCallsInCurrentMonth(callDates: Date[]): number {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  return callDates.filter((createdAt) => {
    const value = new Date(createdAt);
    return value.getMonth() === month && value.getFullYear() === year;
  }).length;
}

function buildMetricCards(params: {
  subscriptionStatus: string;
  cadenceNumber: string;
  trialEndText: string;
  showTrialCard: boolean;
  monthlyCalls: number;
}): string {
  const status = escapeHtml(params.subscriptionStatus || 'pending');

  return `<section class="grid-metrics">
    <article class="card-surface metric-card">
      <p class="metric-label">Subscription status</p>
      <p class="metric-value"><span class="${statusBadgeClass(params.subscriptionStatus)}">${status}</span></p>
      <p class="metric-subvalue">Live account billing status</p>
    </article>

    <article class="card-surface metric-card">
      <p class="metric-label">Cadence phone number</p>
      <p class="metric-value">${escapeHtml(params.cadenceNumber || 'Not provisioned yet')}</p>
      <p class="metric-subvalue">This is your published receptionist line</p>
    </article>

    ${params.showTrialCard ? `<article class="card-surface metric-card">
      <p class="metric-label">Trial end date</p>
      <p class="metric-value">${escapeHtml(params.trialEndText)}</p>
      <p class="metric-subvalue">Trial expiration in America/Phoenix</p>
    </article>` : ''}

    <article class="card-surface metric-card">
      <p class="metric-label">Total calls this month</p>
      <p class="metric-value">${params.monthlyCalls}</p>
      <p class="metric-subvalue">Based on your latest call log records</p>
    </article>
  </section>`;
}

export async function renderDashboard(req: Request, res: Response) {
  try {
    const client = await getAuthenticatedClient(req);
    if (!client) {
      return res.status(401).send('Unauthorized');
    }

    const [subscription, callLogSeed] = await Promise.all([
      getSubscriptionByClientId(client.id),
      getCallLogsPage(client.id, { limit: 300, offset: 0 }),
    ]);

    const monthlyCalls = countCallsInCurrentMonth(callLogSeed.map((call) => call.createdAt));
    const showTrialCard = client.subscriptionStatus === 'trial';

    const headerActionsHtml = `
      <a class="btn btn-ghost" href="/api/clients/${encodeURIComponent(client.id)}/billing-portal">Manage billing</a>
      <a class="btn btn-ghost" href="/login" id="logout-link">Logout</a>
    `;

    const settingsSection = `<section class="panel-stack">
      <article class="card-surface panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Transfer number</h2>
            <p class="panel-subtitle">Where calls are sent when your team asks for a live handoff.</p>
          </div>
        </div>

        <form data-settings-form="transfer">
          <div class="form-row">
            <label for="transfer_number">Phone number</label>
            <input id="transfer_number" name="transfer_number" type="text" value="${escapeHtml(client.transferNumber || '')}" />
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save transfer number</button>
            <p class="form-feedback" id="feedback-transfer"></p>
          </div>
        </form>
      </article>

      <article class="card-surface panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Greeting text</h2>
            <p class="panel-subtitle">The opening line callers hear before Cadence starts helping.</p>
          </div>
        </div>

        <form data-settings-form="greeting">
          <div class="form-row">
            <label for="greeting">Greeting</label>
            <textarea id="greeting" name="greeting">${escapeHtml(client.greeting || '')}</textarea>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save greeting</button>
            <p class="form-feedback" id="feedback-greeting"></p>
          </div>
        </form>
      </article>

      <article class="card-surface panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Business hours</h2>
            <p class="panel-subtitle">JSON object. Example: {"mon":"8am-5pm","sat":"closed"}</p>
          </div>
        </div>

        <form data-settings-form="hours">
          <div class="form-row">
            <label for="hours">Hours</label>
            <textarea id="hours" name="hours">${escapeHtml(JSON.stringify(client.hours, null, 2))}</textarea>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save hours</button>
            <p class="form-feedback" id="feedback-hours"></p>
          </div>
        </form>
      </article>

      <article class="card-surface panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">FAQs</h2>
            <p class="panel-subtitle">JSON array. Example: [{"q":"Do you open weekends?","a":"Yes"}]</p>
          </div>
        </div>

        <form data-settings-form="faqs">
          <div class="form-row">
            <label for="faqs">FAQs</label>
            <textarea id="faqs" name="faqs">${escapeHtml(JSON.stringify(client.faqs, null, 2))}</textarea>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save FAQs</button>
            <p class="form-feedback" id="feedback-faqs"></p>
          </div>
        </form>
      </article>
    </section>`;

    const callLogSection = `<section class="card-surface panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Call log</h2>
          <p class="panel-subtitle">Latest calls with caller number, duration, and summary.</p>
        </div>
      </div>

      <div id="call-log-empty" class="empty-state hidden">No calls yet — your AI receptionist is ready and waiting!</div>

      <div class="table-wrap" id="call-log-table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Caller Number</th>
              <th>Duration</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody id="call-log-body">
            <tr><td colspan="4">Loading call log...</td></tr>
          </tbody>
        </table>
      </div>

      <div class="form-actions" style="margin-top: 12px;">
        <button class="btn btn-secondary hidden" id="load-more-calls" type="button">Load more</button>
      </div>
    </section>`;

    const subscriptionSection = `<section class="card-surface panel">
      <div class="panel-header">
        <div>
          <h2 class="panel-title">Subscription</h2>
          <p class="panel-subtitle">Current plan details and billing access.</p>
        </div>
      </div>

      <div class="grid-metrics" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
        <article class="metric-card card-surface">
          <p class="metric-label">Current plan status</p>
          <p class="metric-value"><span class="${statusBadgeClass(client.subscriptionStatus)}">${escapeHtml(client.subscriptionStatus)}</span></p>
          <p class="metric-subvalue">Trial end: ${escapeHtml(formatDateOnly(subscription?.trialEnd))}</p>
        </article>

        <article class="metric-card card-surface">
          <p class="metric-label">Billing period</p>
          <p class="metric-value" style="font-size: 1rem;">${escapeHtml(formatDateOnly(subscription?.currentPeriodStart))} → ${escapeHtml(formatDateOnly(subscription?.currentPeriodEnd))}</p>
          <p class="metric-subvalue">Last updated: ${escapeHtml(formatDateTime(subscription?.updatedAt))}</p>
        </article>
      </div>

      <div style="margin-top: 12px;">
        <a class="btn btn-primary" href="/api/clients/${encodeURIComponent(client.id)}/billing-portal">Manage Subscription</a>
      </div>
    </section>`;

    const contentHtml = `${buildMetricCards({
      subscriptionStatus: client.subscriptionStatus,
      cadenceNumber: client.twilioNumber || 'Not provisioned yet',
      trialEndText: formatDateOnly(subscription?.trialEnd),
      showTrialCard,
      monthlyCalls,
    })}

    ${callLogSection}

    ${settingsSection}

    ${subscriptionSection}

    <script>
      const clientId = ${JSON.stringify(client.id)};
      const callBody = document.getElementById('call-log-body');
      const emptyState = document.getElementById('call-log-empty');
      const callTableWrap = document.getElementById('call-log-table-wrap');
      const loadMoreButton = document.getElementById('load-more-calls');
      const logoutLink = document.getElementById('logout-link');

      const CALL_PAGE_SIZE = 12;
      let callOffset = 0;
      let callHasMore = false;
      let callLoading = false;

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

      function renderCallRow(call) {
        const date = escapeClient(formatDateClient(call.created_at));
        const caller = escapeClient(call.caller_number || 'Unknown');
        const duration = escapeClient(call.duration_seconds == null ? '—' : call.duration_seconds + 's');
        const summary = escapeClient(call.transcript_summary || '—');

        return '<tr><td>' + date + '</td><td>' + caller + '</td><td>' + duration + '</td><td>' + summary + '</td></tr>';
      }

      function updateCallControls() {
        if (callHasMore) {
          loadMoreButton.classList.remove('hidden');
        } else {
          loadMoreButton.classList.add('hidden');
        }
      }

      async function loadCalls(reset) {
        if (callLoading) return;
        callLoading = true;

        if (reset) {
          callOffset = 0;
          callBody.innerHTML = '<tr><td colspan="4">Loading call log...</td></tr>';
        }

        try {
          const response = await fetch('/api/clients/' + encodeURIComponent(clientId) + '/calls?limit=' + CALL_PAGE_SIZE + '&offset=' + callOffset, {
            headers: { Accept: 'application/json' }
          });

          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || 'Failed to load calls');
          }

          const calls = Array.isArray(payload.calls) ? payload.calls : [];

          if (reset) {
            if (calls.length === 0) {
              callBody.innerHTML = '';
              emptyState.classList.remove('hidden');
              callTableWrap.classList.add('hidden');
              callHasMore = false;
              updateCallControls();
              return;
            }

            emptyState.classList.add('hidden');
            callTableWrap.classList.remove('hidden');
            callBody.innerHTML = calls.map(renderCallRow).join('');
          } else {
            callBody.insertAdjacentHTML('beforeend', calls.map(renderCallRow).join(''));
          }

          callHasMore = Boolean(payload.pagination && payload.pagination.has_more);
          callOffset = Number(payload.pagination && payload.pagination.next_offset != null
            ? payload.pagination.next_offset
            : callOffset + calls.length);
          updateCallControls();
        } catch (error) {
          callBody.innerHTML = '<tr><td colspan="4">Failed to load call log.</td></tr>';
          callHasMore = false;
          updateCallControls();
        } finally {
          callLoading = false;
        }
      }

      function setFeedback(targetId, message, ok) {
        const node = document.getElementById(targetId);
        if (!node) return;
        node.className = 'form-feedback ' + (ok ? 'feedback-ok' : 'feedback-error');
        node.textContent = message;
      }

      async function saveSettings(kind, payload) {
        const feedbackId = 'feedback-' + kind;
        setFeedback(feedbackId, 'Saving...', true);

        try {
          const response = await fetch('/api/clients/' + encodeURIComponent(clientId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(body.error || 'Failed to save changes');
          }

          setFeedback(feedbackId, 'Saved successfully.', true);
        } catch (error) {
          setFeedback(feedbackId, error instanceof Error ? error.message : 'Failed to save', false);
        }
      }

      document.querySelectorAll('form[data-settings-form]').forEach((form) => {
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const kind = form.getAttribute('data-settings-form');

          if (kind === 'transfer') {
            const transferNumber = form.querySelector('input[name="transfer_number"]').value.trim();
            saveSettings('transfer', { transfer_number: transferNumber || null });
            return;
          }

          if (kind === 'greeting') {
            const greeting = form.querySelector('textarea[name="greeting"]').value;
            saveSettings('greeting', { greeting: greeting || null });
            return;
          }

          if (kind === 'hours') {
            const hours = form.querySelector('textarea[name="hours"]').value;
            saveSettings('hours', { hours: hours || '{}' });
            return;
          }

          if (kind === 'faqs') {
            const faqs = form.querySelector('textarea[name="faqs"]').value;
            saveSettings('faqs', { faqs: faqs || '[]' });
          }
        });
      });

      loadMoreButton.addEventListener('click', () => {
        if (!callHasMore || callLoading) return;
        loadCalls(false);
      });

      if (logoutLink) {
        logoutLink.addEventListener('click', (event) => {
          event.preventDefault();
          document.cookie = 'cadence_token=; Max-Age=0; path=/';
          window.location.href = '/login';
        });
      }

      loadCalls(true);
    </script>`;

    const page = renderAppShell({
      title: 'Cadence Dashboard',
      headerTitle: 'Cadence Dashboard',
      headerSubtitle: client.businessName,
      headerActionsHtml,
      contentHtml,
    });

    return res.status(200).type('html').send(page);
  } catch (err) {
    logger.error({ err }, 'GET /dashboard failed');
    return res.status(500).send('Failed to load dashboard');
  }
}
