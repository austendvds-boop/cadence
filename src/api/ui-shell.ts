type ShellOptions = {
  title: string;
  headerTitle?: string;
  headerSubtitle?: string;
  headerActionsHtml?: string;
  contentHtml: string;
  footerHtml?: string;
  bodyClassName?: string;
};

export function escapeHtml(value: unknown): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function statusBadgeClass(status: unknown): string {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';

  switch (normalized) {
    case 'active':
      return 'badge badge-active';
    case 'trial':
      return 'badge badge-trial';
    case 'past_due':
      return 'badge badge-past-due';
    case 'canceled':
      return 'badge badge-canceled';
    default:
      return 'badge badge-pending';
  }
}

export function renderAppShell(options: ShellOptions): string {
  const headerTitle = options.headerTitle ? escapeHtml(options.headerTitle) : '';
  const headerSubtitle = options.headerSubtitle ? escapeHtml(options.headerSubtitle) : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/cadence-ui.css" />
</head>
<body class="app-body ${escapeHtml(options.bodyClassName || '')}">
  <div class="bg-orb bg-orb-purple"></div>
  <div class="bg-orb bg-orb-cyan"></div>
  <div class="app-shell">
    ${options.headerTitle ? `<header class="topbar card-surface">
      <div>
        <p class="eyebrow">Cadence by Autom8</p>
        <h1 class="topbar-title">${headerTitle}</h1>
        ${headerSubtitle ? `<p class="topbar-subtitle">${headerSubtitle}</p>` : ''}
      </div>
      ${options.headerActionsHtml ? `<div class="topbar-actions">${options.headerActionsHtml}</div>` : ''}
    </header>` : ''}

    <main class="page-content">
      ${options.contentHtml}
    </main>

    ${options.footerHtml ? `<footer class="app-footer">${options.footerHtml}</footer>` : ''}
  </div>
</body>
</html>`;
}
