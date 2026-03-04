import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { dbQuery } from '../db/client';
import {
  createClient,
  deactivateClient,
  getClientById,
  getClientByOwnerEmail,
  getClientByStripeCustomerId,
  getClientByStripeSubscriptionId,
  updateClient,
  type Client,
  type SubscriptionStatus,
} from '../db/queries';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

const CHECKOUT_TRIAL_DAYS = 7;
const DEFAULT_STRIPE_WEBHOOK_SECRET = 'whsec_UWmBZ7PE0of6Uz48Ir2Anz7P0DfegRg4';

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
  if (stripeClient) return stripeClient;

  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }

  stripeClient = new Stripe(env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAreaCode(value: unknown): string {
  const digits = asTrimmedString(value).replace(/\D/g, '');
  return digits.length === 3 ? digits : '';
}

function stripeRefToId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

function toDateFromUnixSeconds(value: number | null | undefined): Date | null {
  if (!value || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'past_due':
    case 'incomplete':
    case 'incomplete_expired':
    case 'unpaid':
    case 'paused':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      return 'trial';
  }
}

function getSubscriptionPeriodUnix(subscription: Stripe.Subscription, key: 'current_period_start' | 'current_period_end'): number | null {
  const value = (subscription as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function getCheckoutSuccessUrl(): string {
  return env.STRIPE_CHECKOUT_SUCCESS_URL || `${env.BASE_URL}/onboarding/success?session_id={CHECKOUT_SESSION_ID}`;
}

function getCheckoutCancelUrl(): string {
  return env.STRIPE_CHECKOUT_CANCEL_URL || `${env.BASE_URL}/onboarding`;
}

async function hasProcessedStripeEvent(eventId: string): Promise<boolean> {
  const result = await dbQuery(
    `
      SELECT 1
      FROM stripe_events
      WHERE event_id = $1
      LIMIT 1
    `,
    [eventId]
  );

  return (result.rowCount ?? 0) > 0;
}

async function markStripeEventProcessed(eventId: string, eventType: string): Promise<void> {
  await dbQuery(
    `
      INSERT INTO stripe_events (event_id, event_type)
      VALUES ($1, $2)
      ON CONFLICT (event_id) DO NOTHING
    `,
    [eventId, eventType]
  );
}

type UpsertSubscriptionInput = {
  clientId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId?: string | null;
  status: string;
  trialStart?: Date | null;
  trialEnd?: Date | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  lastPaymentError?: string | null;
  lastInvoiceId?: string | null;
};

async function upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
  await dbQuery(
    `
      INSERT INTO subscriptions (
        client_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_price_id,
        status,
        trial_start,
        trial_end,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        last_payment_error,
        last_invoice_id
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12
      )
      ON CONFLICT (client_id)
      DO UPDATE SET
        stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        stripe_price_id = EXCLUDED.stripe_price_id,
        status = EXCLUDED.status,
        trial_start = EXCLUDED.trial_start,
        trial_end = EXCLUDED.trial_end,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        last_payment_error = EXCLUDED.last_payment_error,
        last_invoice_id = EXCLUDED.last_invoice_id,
        updated_at = NOW()
    `,
    [
      input.clientId,
      input.stripeCustomerId,
      input.stripeSubscriptionId,
      input.stripePriceId ?? null,
      input.status,
      input.trialStart ?? null,
      input.trialEnd ?? null,
      input.currentPeriodStart ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ?? false,
      input.lastPaymentError ?? null,
      input.lastInvoiceId ?? null,
    ]
  );
}

async function findClientForStripeEvent(options: {
  clientId?: string;
  customerId?: string;
  subscriptionId?: string;
  email?: string;
}): Promise<Client | null> {
  if (options.clientId) {
    const client = await getClientById(options.clientId);
    if (client) return client;
  }

  if (options.customerId) {
    const client = await getClientByStripeCustomerId(options.customerId);
    if (client) return client;
  }

  if (options.subscriptionId) {
    const client = await getClientByStripeSubscriptionId(options.subscriptionId);
    if (client) return client;
  }

  if (options.email) {
    const client = await getClientByOwnerEmail(options.email);
    if (client) return client;
  }

  return null;
}

async function provisionClientInline(clientId: string): Promise<void> {
  const client = await getClientById(clientId);
  if (!client) {
    throw new Error(`Client ${clientId} not found during provisioning`);
  }

  logger.info(
    {
      clientId,
      alreadyHasTwilioNumber: Boolean(client.twilioNumber),
      subscriptionStatus: client.subscriptionStatus,
    },
    'Provisioning trigger acknowledged'
  );
}

async function handleCheckoutSessionCompleted(event: Stripe.Event): Promise<void> {
  const stripe = getStripeClient();
  const session = event.data.object as Stripe.Checkout.Session;

  const customerId = stripeRefToId(session.customer);
  const subscriptionId = stripeRefToId(session.subscription);
  const metadata = session.metadata ?? {};

  const client = await findClientForStripeEvent({
    clientId: asTrimmedString(metadata.clientId),
    customerId,
    subscriptionId,
    email: asTrimmedString(session.customer_details?.email),
  });

  if (!client) {
    logger.warn(
      {
        eventId: event.id,
        customerId,
        subscriptionId,
      },
      'Unable to resolve client for checkout.session.completed'
    );
    return;
  }

  const baseStatus: SubscriptionStatus = session.payment_status === 'paid' ? 'active' : 'trial';

  const updated = await updateClient(client.id, {
    stripeCustomerId: customerId || client.stripeCustomerId,
    stripeSubscriptionId: subscriptionId || client.stripeSubscriptionId,
    subscriptionStatus: baseStatus,
  });

  let finalClient = updated ?? client;

  if (customerId && subscriptionId) {
    const rawSubscription = await stripe.subscriptions.retrieve(subscriptionId);
    const subscription = rawSubscription as unknown as Stripe.Subscription;
    const mappedStatus = mapStripeSubscriptionStatus(subscription.status);

    await upsertSubscription({
      clientId: finalClient.id,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0]?.price?.id ?? null,
      status: subscription.status,
      trialStart: toDateFromUnixSeconds(subscription.trial_start),
      trialEnd: toDateFromUnixSeconds(subscription.trial_end),
      currentPeriodStart: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_start')),
      currentPeriodEnd: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_end')),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      lastInvoiceId: stripeRefToId(subscription.latest_invoice),
    });

    const withSubscription = await updateClient(finalClient.id, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: mappedStatus,
    });

    if (withSubscription) {
      finalClient = withSubscription;
    }
  }

  await provisionClientInline(finalClient.id);
}

async function handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = stripeRefToId(subscription.customer);

  if (!customerId) {
    logger.warn({ eventId: event.id, subscriptionId: subscription.id }, 'Subscription event missing customer id');
    return;
  }

  const client = await findClientForStripeEvent({
    customerId,
    subscriptionId: subscription.id,
  });

  if (!client) {
    logger.warn({ eventId: event.id, customerId, subscriptionId: subscription.id }, 'Unable to resolve client for subscription update');
    return;
  }

  await upsertSubscription({
    clientId: client.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.items.data[0]?.price?.id ?? null,
    status: subscription.status,
    trialStart: toDateFromUnixSeconds(subscription.trial_start),
    trialEnd: toDateFromUnixSeconds(subscription.trial_end),
    currentPeriodStart: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_start')),
    currentPeriodEnd: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_end')),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    lastInvoiceId: stripeRefToId(subscription.latest_invoice),
  });

  const mappedStatus = mapStripeSubscriptionStatus(subscription.status);
  const updatedClient = await updateClient(client.id, {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: mappedStatus,
  });

  if (updatedClient && (mappedStatus === 'trial' || mappedStatus === 'active')) {
    await provisionClientInline(updatedClient.id);
  }
}

async function handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = stripeRefToId(subscription.customer);

  const client = await findClientForStripeEvent({
    customerId,
    subscriptionId: subscription.id,
  });

  if (!client) {
    logger.warn({ eventId: event.id, customerId, subscriptionId: subscription.id }, 'Unable to resolve client for subscription deletion');
    return;
  }

  const resolvedCustomerId = customerId || client.stripeCustomerId || '';
  if (resolvedCustomerId) {
    await upsertSubscription({
      clientId: client.id,
      stripeCustomerId: resolvedCustomerId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.items.data[0]?.price?.id ?? null,
      status: 'canceled',
      trialStart: toDateFromUnixSeconds(subscription.trial_start),
      trialEnd: toDateFromUnixSeconds(subscription.trial_end),
      currentPeriodStart: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_start')),
      currentPeriodEnd: toDateFromUnixSeconds(getSubscriptionPeriodUnix(subscription, 'current_period_end')),
      cancelAtPeriodEnd: true,
      lastInvoiceId: stripeRefToId(subscription.latest_invoice),
    });
  }

  await deactivateClient(client.id);
}

async function handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = stripeRefToId(invoice.customer);
  const subscriptionId = stripeRefToId(
    (invoice as { subscription?: unknown }).subscription
      ?? (invoice as { parent?: { subscription_details?: { subscription?: unknown } } }).parent?.subscription_details?.subscription
  );

  const client = await findClientForStripeEvent({
    customerId,
    subscriptionId,
  });

  if (!client) {
    logger.warn(
      {
        eventId: event.id,
        customerId,
        subscriptionId,
      },
      'Unable to resolve client for invoice.payment_failed'
    );
    return;
  }

  const paymentError =
    asTrimmedString((invoice as { last_payment_error?: { message?: string } }).last_payment_error?.message)
    || asTrimmedString((invoice as { last_finalization_error?: { message?: string } }).last_finalization_error?.message)
    || 'Payment failed';

  const resolvedCustomerId = customerId || client.stripeCustomerId || '';
  const resolvedSubscriptionId = subscriptionId || client.stripeSubscriptionId || '';

  if (resolvedCustomerId && resolvedSubscriptionId) {
    await upsertSubscription({
      clientId: client.id,
      stripeCustomerId: resolvedCustomerId,
      stripeSubscriptionId: resolvedSubscriptionId,
      stripePriceId: null,
      status: 'past_due',
      cancelAtPeriodEnd: false,
      lastPaymentError: paymentError,
      lastInvoiceId: invoice.id,
    });
  }

  await deactivateClient(client.id);
}

export async function handleStripeCheckout(req: Request, res: Response) {
  try {
    const stripe = getStripeClient();

    if (!env.STRIPE_PRICE_ID) {
      return res.status(500).json({ error: 'STRIPE_PRICE_ID is not configured' });
    }

    const body = asRecord(req.body);
    const email = asTrimmedString(body.email || body.clientEmail || body.client_email);
    const businessName = asTrimmedString(body.businessName || body.business_name);
    const ownerPhone = asTrimmedString(body.ownerPhone || body.owner_phone);
    const areaCode = normalizeAreaCode(body.areaCode || body.area_code);

    if (!email || !businessName) {
      return res.status(400).json({ error: 'email and businessName are required' });
    }

    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    const stripeCustomer = existingCustomers.data[0]
      ?? await stripe.customers.create({
        email,
        name: businessName,
        metadata: {
          businessName,
        },
      });

    const existingClient = await getClientByOwnerEmail(email);
    const client = existingClient
      ? (await updateClient(existingClient.id, {
          businessName,
          ownerPhone: ownerPhone || existingClient.ownerPhone,
          stripeCustomerId: stripeCustomer.id,
          subscriptionStatus: 'trial',
        })) ?? existingClient
      : await createClient({
          businessName,
          ownerEmail: email,
          ownerPhone: ownerPhone || null,
          stripeCustomerId: stripeCustomer.id,
          subscriptionStatus: 'trial',
        });

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomer.id,
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: CHECKOUT_TRIAL_DAYS,
        metadata: {
          clientId: client.id,
          areaCode,
        },
      },
      metadata: {
        clientId: client.id,
        businessName,
        areaCode,
      },
      success_url: getCheckoutSuccessUrl(),
      cancel_url: getCheckoutCancelUrl(),
    });

    if (!checkoutSession.url) {
      return res.status(500).json({ error: 'Stripe checkout session did not return a URL' });
    }

    return res.json({ url: checkoutSession.url });
  } catch (err) {
    logger.error({ err }, 'Failed to create Stripe checkout session');
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

export async function handleStripeWebhook(req: Request, res: Response) {
  let event: Stripe.Event;

  try {
    const stripe = getStripeClient();
    const signatureHeader = req.headers['stripe-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    const webhookSecret = env.STRIPE_WEBHOOK_SECRET || DEFAULT_STRIPE_WEBHOOK_SECRET;
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    logger.error({ err }, 'Stripe webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  try {
    if (await hasProcessedStripeEvent(event.id)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event);
        break;
      default:
        logger.info({ eventType: event.type }, 'Ignoring unsupported Stripe webhook event');
        break;
    }

    await markStripeEventProcessed(event.id, event.type);
    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, eventId: event.id, eventType: event.type }, 'Stripe webhook handler failed');
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}

export async function handleProvisionRequest(req: Request, res: Response) {
  try {
    const body = asRecord(req.body);
    const clientId = asTrimmedString(body.clientId || body.client_id);

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    await provisionClientInline(clientId);
    return res.status(200).json({ ok: true, clientId });
  } catch (err) {
    logger.error({ err }, 'Provision request failed');
    return res.status(500).json({ error: 'Provision request failed' });
  }
}
