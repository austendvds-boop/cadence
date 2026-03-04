import Stripe from 'stripe';

const WEBHOOK_URL = 'https://cadence-m48n.onrender.com/api/stripe/webhook';
const ENABLED_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

const CURRENT_RENDER_WEBHOOK_SECRET = 'whsec_UWmBZ7PE0of6Uz48Ir2Anz7P0DfegRg4';
const RENDER_SERVICE_ID = 'srv-d6icmgp5pdvs73e15v60';
const RENDER_ENV_KEY = 'STRIPE_WEBHOOK_SECRET';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function updateRenderWebhookSecret(renderApiToken: string, webhookSecret: string): Promise<void> {
  const endpoint = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars/${RENDER_ENV_KEY}`;
  const headers = {
    Authorization: `Bearer ${renderApiToken}`,
    'Content-Type': 'application/json',
  };
  const body = JSON.stringify({ value: webhookSecret });

  const patchResponse = await fetch(endpoint, {
    method: 'PATCH',
    headers,
    body,
  });

  if (patchResponse.ok) {
    console.log(`Updated Render ${RENDER_ENV_KEY} via PATCH.`);
    return;
  }

  const patchError = await patchResponse.text();
  if (patchResponse.status !== 405) {
    throw new Error(`Render env var PATCH failed (${patchResponse.status}): ${patchError}`);
  }

  const putResponse = await fetch(endpoint, {
    method: 'PUT',
    headers,
    body,
  });

  if (!putResponse.ok) {
    const putError = await putResponse.text();
    throw new Error(`Render env var PUT fallback failed (${putResponse.status}): ${putError}`);
  }

  console.log(`Render rejected PATCH (405); updated ${RENDER_ENV_KEY} via PUT fallback.`);
}

async function main(): Promise<void> {
  const stripeSecretKey = requireEnv('STRIPE_SECRET_KEY');
  const stripe = new Stripe(stripeSecretKey);

  const createdEndpoint = await stripe.webhookEndpoints.create({
    url: WEBHOOK_URL,
    enabled_events: ENABLED_EVENTS,
    description: 'Cadence subscription lifecycle webhook',
  });

  console.log(`Created Stripe webhook endpoint: ${createdEndpoint.id}`);

  if (!createdEndpoint.secret) {
    throw new Error('Stripe did not return a webhook signing secret.');
  }

  console.log(`Webhook signing secret: ${createdEndpoint.secret}`);

  if (createdEndpoint.secret !== CURRENT_RENDER_WEBHOOK_SECRET) {
    const renderApiToken = requireEnv('RENDER_API_TOKEN');
    await updateRenderWebhookSecret(renderApiToken, createdEndpoint.secret);
  } else {
    console.log('Webhook signing secret matches existing Render secret. No Render update needed.');
  }

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const matching = endpoints.data.filter((endpoint) => endpoint.url === WEBHOOK_URL);

  if (matching.length === 0) {
    throw new Error(`Verification failed: no webhook endpoint found for ${WEBHOOK_URL}`);
  }

  console.log(`Verified ${matching.length} webhook endpoint(s) for ${WEBHOOK_URL}:`);
  for (const endpoint of matching) {
    const events = endpoint.enabled_events.join(', ');
    console.log(`- ${endpoint.id} [${endpoint.status}] events=${events}`);
  }
}

main().catch((error) => {
  console.error('Stripe webhook registration failed:', error);
  process.exitCode = 1;
});
