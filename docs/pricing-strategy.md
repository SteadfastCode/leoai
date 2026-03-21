# LeoAI — Pricing Strategy & Marketing

---

## Customer Discovery — Talk to Real People First

Pricing and marketing decisions should be grounded in real conversations, not assumptions. Pre-launch is the ideal time — no anchor prices, no existing customers to upset.

**Who to talk to:**
- Small business owners you know personally (restaurants, retail, service businesses)
- Pastors and church staff — especially smaller, volunteer-run churches
- Anyone already paying for a website tool, chatbot, or customer communication product

**Don't ask "what would you pay?" — it doesn't work.** People either low-ball defensively or try to please you. Ask instead:
- *"What do you currently spend on your website, social media, or customer communication tools?"*
- *"If something like this existed, where would it fit in your budget — is it a 'nice to have' or does it solve a real problem?"*
- *"What would make this a no-brainer vs. a hard sell to your board/spouse/business partner?"*

**The church conversation is different from the business one.** Churches have budget committees, fiscal years, and a stewardship culture. A pastor might love Leo personally but know it'll face pushback from the finance elder. Understanding that dynamic shapes both pricing and how you frame the value.

**What you're really trying to learn:**
1. Is the problem real to them, or a problem you're imagining for them?
2. What mental category do they put this in — "marketing tool," "staff replacement," "ministry resource"?
3. What's their current friction — are they already paying for something that doesn't work well?

**These conversations generate your first customers.** If someone says "yeah, I'd pay $20/month for that," the natural next line is "I'm finishing the beta — want to be one of the first five?" That's your waitlist.

Even 3–5 honest conversations will sharpen your intuition more than any amount of internal debate.

---

## Ministry Plan

Churches and ministries: **50% off** equivalent business pricing. Not a coupon — a distinct plan with its own positioning. LeoAI is built with faith-driven values; churches are a mission-critical audience, not just a market segment.

**Is the discount viable?**
This depends heavily on which plan the church is on — and most small churches (low traffic, 20-50 messages/month) will naturally land on PAYG, not Infinity. Don't steer them toward Infinity if they don't need it. A modest PAYG discount (e.g., $0.007/message vs. $0.01) is still meaningful to them at low cost to you. The Infinity discount conversation is really about mid-size and larger churches that actually generate enough traffic to need unlimited.

Mid-size churches likely have more willingness to pay than the 50% framing implies. A 300-member church paying $30/mo for Leo is a rounding error compared to Planning Center ($50-150/mo for many churches), their AV system, or their website. The ceiling may be higher than assumed — customer discovery will tell you.

The 50% number is round and intuitive but wasn't derived from cost analysis or real conversations. 30% off might be more defensible and still feel genuinely generous. Defer the exact percentage until there's data from actual church conversations.

Long-term viability of any discount comes down to operating cost efficiency: tiered model routing (Haiku for simple queries), semantic caching, and smart RAG. Those levers matter more than the headline discount percentage.

The LeoRefresh offset is real: churches need it more than most (weekly events, sermons, announcements change constantly). A church on Ministry Infinity + LeoRefresh is $20/mo at current pricing — same revenue as a full-price business on Infinity alone.

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

**Full infrastructure cost stack (not just API):**

| Cost | Estimate | Notes |
|---|---|---|
| MongoDB Atlas M10 | ~$57/mo | Required for production; M0 free tier works for beta |
| Backend hosting | ~$10-20/mo | Railway/Render/Fly.io — $10-15 for a small Node app |
| Vercel (frontend) | $0-20/mo | Free tier likely sufficient until significant traffic |
| Twilio SMS | ~$1-5/mo | $1/mo for phone number + ~$0.008/SMS; 200 handoff SMS ≈ $2.60 |
| Email (SMTP) | $0-10/mo | Nodemailer + transactional service; SendGrid/Mailgun free tier covers early scale |
| Voyage AI (embeddings) | ~$0-2/mo | voyage-3-lite at $0.02/MTok; scraping 500 pages ≈ $0.004 per entity. Negligible at current scale |
| Domains | ~$2-5/mo | leo-ai.chat, leo-ai.app, steadfastcode.tech combined |
| Stripe fees | 2.9% + $0.30/txn | On $20/mo subscription: ~$0.88/txn = $19.12 net. On PAYG: **cannot charge $0.01/message** — Stripe minimum is $0.50. PAYG billing must batch to monthly invoice or threshold triggers |
| Error tracking | $0 | Sentry free tier covers small projects |
| **Total fixed overhead** | **~$75-110/mo** | Before a single API call |

That's 4-6 Infinity customers at $20/mo just to cover fixed costs, before any per-message API expense. Message cost optimization is the single lever that improves every other calculation.

**Stripe PAYG note:** PAYG is monthly billing — messages accumulate through the month and are charged once at the end of the period. No Stripe minimum issue.

**Current Haiku usage in code:** Haiku is already used for `summarizeTopic` (returning visitor greeting — fire-and-forget, 60 tokens). The main `chat()` function uses Sonnet for everything. Tiered routing on actual chat messages is not yet built.

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

**Lifetime Deal — Tiered Rollout Strategy**

The $777 price was designed for memorability (all 7s) but is financially too generous — break-even at ~39 months means any customer retained past 3.25 years costs money indefinitely. The right break-even is 5-7 years, which puts the sustainable floor at $1,777-$2,777.

Planned tiered rollout:

| Tier | Price | Slots | Who |
|---|---|---|---|
| Alpha/Beta | $777 | 5 | Early testers willing to use unpolished software and give feedback |
| General launch | $1,777 | 10-15 | First real public offering |
| Seasonal reopening | $1,777+ | 3-5 | Christmas, Easter — limited windows, never always-available |

**Alpha/Beta slot expectations:** explicit agreement to report bugs and give feedback. Frames it as a relationship, not just a cheap purchase. The low price is justified by the risk they're taking on early software.

**"No one took it at $777 in 6 months" is useful data.** Price wasn't the blocker — awareness and product readiness were. Raising the price carries essentially zero additional friction. Anyone who saw $777 and didn't buy wasn't going to buy at any price without marketing behind it.

**Seasonal reopening is especially strong for the church audience.** Easter is peak traffic for churches — pastors are thinking about communication and outreach. "5 lifetime slots open for Easter" lands differently in that context than a generic sale.

**Lifetime = a calculated bet on cost curves.** AI inference costs will almost certainly drop over a 7-10 year window. A lifetime customer's actual cost to serve gets cheaper over time even without intervention. That's the hedge that makes the math work long-term.

**The base plans are generous by design — but verify they're not too generous.** $20/mo unlimited is cheap compared to Intercom, Tidio, Drift, or any live chat alternative. Cheap-but-credible is a viable position. Cheap-and-uncertain-of-itself is harder to recover from. If customer conversations reveal higher willingness to pay than expected, there's room to raise the floor before launch — easier to do before anyone has paid than after.

**Frontend presentation:** Hide the pricing table behind a detail layer. Lead with: *"Start free, pay as you grow, cap at $20/month."* Details expand on click.
