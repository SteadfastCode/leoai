const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const Entity = require('../models/Entity');
const { requireAuth } = require('../middleware/auth');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_PRICES = {
  infinity_monthly: process.env.STRIPE_PRICE_INFINITY_MONTHLY,
  infinity_12mo:    process.env.STRIPE_PRICE_INFINITY_12MO,
  lifetime:         process.env.STRIPE_PRICE_LIFETIME,
};

const ADDON_PRICES = {
  leorefresh: process.env.STRIPE_PRICE_LEOREFRESH,
};

// Middleware: verify caller has access to this domain
async function requireEntityAccess(req, res, next) {
  const { domain } = req.params;
  const hasMembership = req.user.memberships?.some((m) => m.entityDomain === domain);
  const isSuperadmin  = req.user.memberships?.some((m) => m.entityDomain === 'steadfastcode.tech');
  if (!hasMembership && !isSuperadmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// GET /api/billing/:domain — current billing state
router.get('/:domain', requireAuth(), requireEntityAccess, async (req, res) => {
  const { domain } = req.params;
  try {
    const entity = await Entity.findOne({ domain }).select(
      'plan subscriptionStatus stripeCustomerId stripeSubscriptionId ' +
      'currentPeriodStart currentPeriodEnd messageCountThisPeriod billingPeriodResetAt messageCount ' +
      'leoRefreshEnabled leoRefreshSubscriptionId leoRefreshHour leoRefreshFrequency leoRefreshLastRun'
    );
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    res.json({
      plan: entity.plan,
      subscriptionStatus: entity.subscriptionStatus,
      messageCountThisPeriod: entity.messageCountThisPeriod || 0,
      billingPeriodResetAt: entity.billingPeriodResetAt,
      currentPeriodStart: entity.currentPeriodStart,
      currentPeriodEnd: entity.currentPeriodEnd,
      messageCount: entity.messageCount || 0,
      limitThisPeriod: entity.plan === 'free' ? 100 : null,
      hasStripeCustomer: !!entity.stripeCustomerId,
      leoRefreshEnabled: entity.leoRefreshEnabled,
      leoRefreshHour: entity.leoRefreshHour ?? 3,
      leoRefreshFrequency: entity.leoRefreshFrequency ?? 'daily',
      leoRefreshLastRun: entity.leoRefreshLastRun,
    });
  } catch (err) {
    console.error('Billing GET error:', err);
    res.status(500).json({ error: 'Could not load billing info.' });
  }
});

// POST /api/billing/:domain/checkout — create Stripe Checkout session
router.post('/:domain/checkout', requireAuth(), requireEntityAccess, async (req, res) => {
  const { domain } = req.params;
  const { plan } = req.body; // 'infinity_monthly' | 'infinity_12mo' | 'lifetime'

  const priceId = PLAN_PRICES[plan];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown plan: ${plan}` });
  }

  try {
    const entity = await Entity.findOne({ domain });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    const appUrl = process.env.APP_URL || 'http://localhost:5173';

    // Reuse existing customer or let Stripe create one
    const customerParams = entity.stripeCustomerId
      ? { customer: entity.stripeCustomerId }
      : { customer_email: req.user.email };

    const isOneTime = plan === 'lifetime';

    const session = await stripe.checkout.sessions.create({
      ...customerParams,
      mode: isOneTime ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/#/billing?session_id={CHECKOUT_SESSION_ID}&domain=${domain}`,
      cancel_url:  `${appUrl}/#/billing?canceled=1&domain=${domain}`,
      metadata: { domain },
      ...(isOneTime ? {} : {
        subscription_data: { metadata: { domain } },
      }),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// POST /api/billing/:domain/leorefresh/checkout — subscribe to LeoRefresh add-on
router.post('/:domain/leorefresh/checkout', requireAuth(), requireEntityAccess, async (req, res) => {
  const { domain } = req.params;
  const priceId = ADDON_PRICES.leorefresh;
  if (!priceId) return res.status(500).json({ error: 'LeoRefresh price not configured' });

  try {
    const entity = await Entity.findOne({ domain });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    if (entity.leoRefreshEnabled) {
      return res.status(409).json({ error: 'LeoRefresh is already active' });
    }

    const appUrl = process.env.APP_URL || 'http://localhost:5173';
    const customerParams = entity.stripeCustomerId
      ? { customer: entity.stripeCustomerId }
      : { customer_email: req.user.email };

    const session = await stripe.checkout.sessions.create({
      ...customerParams,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/#/settings?domain=${domain}&leorefresh=activated`,
      cancel_url:  `${appUrl}/#/settings?domain=${domain}`,
      metadata: { domain, addon: 'leorefresh' },
      subscription_data: { metadata: { domain, addon: 'leorefresh' } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('LeoRefresh checkout error:', err);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// POST /api/billing/:domain/leorefresh/cancel — cancel LeoRefresh subscription
router.post('/:domain/leorefresh/cancel', requireAuth(), requireEntityAccess, async (req, res) => {
  const { domain } = req.params;
  try {
    const entity = await Entity.findOne({ domain });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    if (!entity.leoRefreshSubscriptionId) {
      return res.status(400).json({ error: 'No active LeoRefresh subscription found' });
    }

    // Cancel at period end so they keep access through the billing period
    await stripe.subscriptions.update(entity.leoRefreshSubscriptionId, {
      cancel_at_period_end: true,
    });

    res.json({ ok: true, message: 'LeoRefresh will cancel at the end of the current billing period.' });
  } catch (err) {
    console.error('LeoRefresh cancel error:', err);
    res.status(500).json({ error: 'Could not cancel LeoRefresh.' });
  }
});

// POST /api/billing/:domain/portal — create Stripe Billing Portal session
router.post('/:domain/portal', requireAuth(), requireEntityAccess, async (req, res) => {
  const { domain } = req.params;
  try {
    const entity = await Entity.findOne({ domain });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    if (!entity.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found. Subscribe first.' });
    }

    const appUrl = process.env.APP_URL || 'http://localhost:5173';

    const session = await stripe.billingPortal.sessions.create({
      customer: entity.stripeCustomerId,
      return_url: `${appUrl}/#/billing?domain=${domain}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Could not open billing portal.' });
  }
});

module.exports = router;
