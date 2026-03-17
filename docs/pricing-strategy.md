# LeoAI — Pricing Strategy & Marketing

---

## Ministry Plan

Churches and ministries: **50% off** equivalent business pricing. Not a coupon — a distinct plan with its own positioning. LeoAI is built with faith-driven values; churches are a mission-critical audience, not just a market segment.

**Key decisions:**
- Church & Ministry Mode is **not self-service** — Daniel enables it after review. Both fraud prevention and quality control. Entities see "Request Ministry Plan" button; Daniel approves within 24-48 hours.
- **Verification: lightweight honor system + website review.** No 501(c)(3) required — that excludes legitimate unincorporated ministries. Entity provides name + brief description; Daniel (or automated scrape check) reviews. Risk of abuse is minimal (lying to save $10-15/month on a niche B2B product).
- **Live Chat add-on** is disproportionately valuable for churches (pastoral care, counseling handoffs) — same 50% discount applies.
- Church word-of-mouth (denomination networks, pastor referrals) is high-value. One church recommending Leo to their network is worth more than the margin recovered by charging full price.

---

## Live Chat Pricing for Small Businesses

Live chat is a different tier — real-time human connection infrastructure. Worth more than the base product.

- **Sole proprietors / startups:** Live chat is mostly useless — no one to staff it. Don't push it at them.
- **Established small businesses with a CSR or team:** Real value, worth premium pricing. Good alignment — the customers who benefit most have the most budget.

**Suggested positioning:** Bundle Live Chat + LeoRefresh + Messenger into a "Pro" plan (~$40-50/month) rather than selling each add-on separately. Reduces per-feature price friction, increases ARPU on best customers.

---

## Marketing — Two Separate Campaigns

Small businesses and churches need entirely separate campaigns. Different messaging, channels, and value props.

**Small Business:**
- Angle: *"Never miss a customer. 24/7 answers, no extra staff."*
- Pain point: sole proprietors who can't be available around the clock
- Channels: local business associations, Google/Meta ads, small business communities

**Church & Ministry:**
- Angle: *"Serve your congregation better. Leo handles the questions so your team can handle the people."*
- Pain point: volunteer-run orgs with limited staff; visitors who need connection, not just information
- Channels: pastor networks, denomination conferences, ministry podcasts, word-of-mouth
- Tone: warm, mission-driven, not salesy — this audience is allergic to hype

---

## ⚠️ PAYG & Infinity Plan Pricing — Needs Rebuild Before Launch

The current pricing was designed before Claude API costs were factored in. It's not viable as-is.

**The math:**
- Claude Sonnet per message: ~3,000 input tokens + ~200 output tokens ≈ **$0.01-0.012 in API costs alone**
- PAYG at $0.01/message: at or below break-even before any infrastructure or margin
- Infinity at $20/month: breaks even only if avg usage stays under ~1,500-2,000 messages/month — likely not realistic for active businesses

**Do not finalize or advertise pricing until:**
1. **Tiered model routing is built** (Haiku for simple queries, Sonnet for complex) — blended cost could drop to ~$0.002-0.003/message at a 70/30 split, which changes everything
2. **Alpha usage data is in** — real message volume per entity determines what Infinity needs to cost
3. **Semantic response cache is evaluated** — 40% cache hit rate at Haiku rephrase cost further reduces blended cost

**Likely direction:**
- PAYG: raise to $0.03-0.05/message (still cheap vs. alternatives, actually sustainable)
- Infinity: raise floor to $35-40/month, or restructure around message volume tiers
- Milestone retroactive discounting mechanic is still a differentiator — keep it, adjust the numbers

**The marketing site pricing grid must come down immediately** — see note below.

---

## ⚠️ Marketing Site — Remove Pricing Grid Now

The detailed pricing grid on steadfastcode.tech needs to come down before any real traffic hits it. The numbers are based on pre-API assumptions and will need to change.

**Replace with simple messaging (already decided):**
- Lead with: *"Start free. Pay as you grow. Never more than you need."*
- Secondary: *"Free to start • Simple pay-as-you-go • Unlimited plans available"*
- No specific dollar amounts, no grid — just enough to signal it's accessible
- "Pricing" CTA takes them to a waitlist or contact form until numbers are finalized

This is a marketing site task, not a backend task — but flag it before any alpha outreach begins.

---

## Free Tier Limit — Revisit at Alpha

The 100 message free tier is likely a 2-3 week runway for most real implementations, not a full month. Rough math: a small local business site with modest traffic generates ~2-5 chatbot conversations/day at 3-6 messages each = 300-400+ messages/month. Even a quiet site (~1 conversation/day) hits ~120/month.

**100 messages functions as a trial tier, not a sustainable free plan.** That's a valid strategy (Intercom, Tidio use the same playbook) but should be intentional, not accidental.

**Alpha testing plan:** Test with a mix of high-traffic and low-traffic businesses. Capture per-entity:
- Messages per conversation (avg session depth)
- Conversations per day
- What % of entities would stay under 100 / 250 / 500
- Whether free→PAYG transition causes friction or churn

Set the permanent free tier limit based on that data, not guesswork. At $0.009/message in API costs, 500 free messages costs ~$4.50/month — still manageable if it meaningfully improves conversion.

---

## Pricing Rationale

**Pay-as-you-go** is intentionally low-margin. Accessibility for struggling small businesses is a core value, not just a marketing line. Real revenue comes from Infinity Plans and premium add-ons.

**Milestone retroactive discounting** on pay-as-you-go is unique in the market.

**Frontend presentation:** Hide the pricing table behind a detail layer. Lead with: *"Start free, pay as you grow, cap at $20/month."* Details expand on click.
