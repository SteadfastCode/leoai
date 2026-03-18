const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const Entity = require('../models/Entity');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Map Stripe subscription status → our plan label
function planFromSubscription(sub) {
  // Determine plan from price ID
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (priceId === process.env.STRIPE_PRICE_INFINITY_MONTHLY) return 'infinity';
  if (priceId === process.env.STRIPE_PRICE_INFINITY_12MO)    return 'infinity';
  return 'infinity'; // any active subscription = infinity for now
}

// POST /webhooks/stripe — Stripe sends raw body, verify signature
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const domain  = session.metadata?.domain;
        if (!domain) break;

        const entity = await Entity.findOne({ domain });
        if (!entity) break;

        // Store Stripe customer ID
        if (session.customer) {
          entity.stripeCustomerId = session.customer;
        }

        if (session.metadata?.addon === 'leorefresh') {
          // LeoRefresh add-on subscription
          if (session.subscription) {
            entity.leoRefreshEnabled        = true;
            entity.leoRefreshSubscriptionId = session.subscription;
            if (session.customer) entity.stripeCustomerId = session.customer;
          }
        } else if (session.mode === 'payment') {
          // Lifetime deal
          entity.plan = 'lifetime';
          entity.subscriptionStatus = 'active';
        } else if (session.mode === 'subscription' && session.subscription) {
          // Main plan subscription — fetch full sub to get period dates
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          entity.stripeSubscriptionId = sub.id;
          entity.subscriptionStatus   = sub.status;
          entity.plan                 = planFromSubscription(sub);
          entity.currentPeriodStart   = new Date(sub.current_period_start * 1000);
          entity.currentPeriodEnd     = new Date(sub.current_period_end   * 1000);
        }

        await entity.save();
        break;
      }

      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const domain = sub.metadata?.domain;
        if (!domain) break;

        const entity = await Entity.findOne({ domain });
        if (!entity) break;

        entity.subscriptionStatus = sub.status;
        entity.plan               = sub.status === 'active' ? planFromSubscription(sub) : entity.plan;
        entity.currentPeriodStart = new Date(sub.current_period_start * 1000);
        entity.currentPeriodEnd   = new Date(sub.current_period_end   * 1000);
        await entity.save();
        break;
      }

      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const domain = sub.metadata?.domain;
        if (!domain) break;

        const entity = await Entity.findOne({ domain });
        if (!entity) break;

        if (sub.metadata?.addon === 'leorefresh') {
          // LeoRefresh add-on cancelled
          entity.leoRefreshEnabled        = false;
          entity.leoRefreshSubscriptionId = null;
        } else {
          // Main plan cancelled
          entity.subscriptionStatus   = 'canceled';
          entity.plan                 = 'free';
          entity.stripeSubscriptionId = null;
        }
        await entity.save();
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (!customerId) break;

        const entity = await Entity.findOne({ stripeCustomerId: customerId });
        if (!entity) break;

        entity.subscriptionStatus = 'past_due';
        await entity.save();
        break;
      }

      default:
        // Unhandled event — ignore
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

module.exports = router;
