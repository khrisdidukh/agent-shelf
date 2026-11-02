# Devpost submission: Agent Shelf

**Project name:** Agent Shelf

**Elevator pitch (≤200):**
Shopping agents can’t buy what your listing doesn’t say. Agent Shelf shows a store which buyer requests agents lose it, fixes listings with the owner’s facts, and lets an agent buy via PayPal.

**Try it:** https://agent-shelf.onrender.com
**Code:** https://github.com/khrisdidukh/agent-shelf
**Video:** https://youtu.be/htdqV0a3loo

**Built with:** paypal, paypal-agent-toolkit, paypal-orders-api, paypal-catalog-products-api, channel3, ag-grid, shopify, mock.shop, model-context-protocol, vercel-ai-sdk, qwen, near-ai-cloud, node.js, javascript, render

---

## Inspiration

Buyers have started handing shopping to AI agents: “a soy candle for my mom, lavender, gift-wrapped, under $30.” An agent can only pick a product whose listing *states* those facts. Most small shops write for a person looking at a photo. In the public Shopify sample store we used, a candle’s description reads: “presented on a minimalistic background… highlighted by soft, even lighting.” It describes the photo, not the candle. No scent, no size, no burn time. To an agent, this candle doesn’t exist.

Big retailers have teams for product data. A shop with 30 products has the owner. We built the tool that owner needs before agentic checkout becomes normal.

## What it does

1. **Reads the shelf.** Import a Shopify store (the demo is Amber & Aura from Shopify’s public mock.shop). An AG Grid table ranks every product by how much of what buyers ask agents for its listing actually states.
2. **Shows what agents see.** For one product, Agent Shelf writes 8 realistic buyer requests, runs each against live competitor data from **Channel3**, and has a shopping agent rank the listing against the top 5. The demo candle: picked first in **0 of 8**, lost 7 *only* because the listing doesn’t say enough. A toggle switches between *buyer needs* (what people ask) and *agent data* (what competing products carry: 77% state scent, this one doesn’t).
3. **Asks, never invents.** Missing needs become questions for the owner (“How many hours does it burn?”). The rewrite uses only the owner’s answers, and every new attribute quotes them. Code checks each quote word for word; anything unquoted is dropped and asked again.
4. **Clearer for agents and for people.** The facts agents need (scent, size, burn time, delivery) are what every human shopper checks too, so the rewritten listing reads better for both.
5. **Re-tests.** Same requests, same competitors. Lost for missing facts: **7 → 1**. Buyer needs stated: **26% → 100%**. The remaining losses are honest: those buyers want lavender, not orange.
6. **Lets an agent buy it through PayPal.** An LLM with the **PayPal Agent Toolkit** reads a buyer’s request and the new listing, decides to buy, and calls `create_order` itself. The buyer approves in PayPal, Agent Shelf captures the payment: **COMPLETED, $25.00**. The listing can also be published to the merchant’s **PayPal Catalog** in one click.
7. **Answers other agents.** An MCP endpoint (`/mcp`) exposes `shelf_readiness` and `product_gaps`, so a store’s own assistant or any MCP client can ask “is this product ready to be bought by agents, and what’s missing?”

## How we built it

- **PayPal:** Orders v2 (agent-created order, buyer approval, capture), Catalog Products API, **PayPal Agent Toolkit** through the Vercel AI SDK adapter, all in sandbox.
- **AI:** Qwen3.8-27B on NEAR AI Cloud (OpenAI-compatible API; any compatible provider works). Temperature 0 and prompt-hash caching make a demo run repeatable.
- **Channel3:** live product search, the field an agent actually sees.
- **AG Grid Community:** the store table.
- **Shopify mock.shop:** public, reproducible demo store data. Any Shopify store with a public products feed works too.
- **Model Context Protocol SDK:** Streamable HTTP server for other agents.
- Plain Node.js server, no framework; hosted on Render.

## Challenges we ran into

- **Agents favour listings that echo the query.** Our first buyer requests repeated the product’s own name, so the candle “won” everything. We now name the product type the way shoppers search (“soy candle”) and write requests from buyers who don’t know the shop exists.
- **An AI that writes product copy will invent a burn time.** That is a liability for the merchant and poison for agents, so we made every claim a verified quote.
- **Losing isn’t always a bug.** We split losses into *missing facts* (fixable) and *not a fit* (the buyer wants something else), so the score doesn’t push merchants to claim what isn’t true.
- **PayPal Store Sync** (PayPal’s channel to AI agents) is currently US-only by request, so we prepare listings for it and publish to the Catalog Products API instead.

## Accomplishments that we’re proud of

The full loop runs live on the hosted demo: a real public store → measured invisibility → owner’s answers → a re-tested listing → an AI agent that decides and creates the PayPal order → buyer approval → captured payment.

## What we learned

Agent readiness is mostly about saying plain facts that people never needed to read: size, burn time, materials, delivery. The agent does the rest.

## What’s next

- Store-wide answers (shipping and returns once, applied to every product).
- Pushing fixed attributes back to Shopify and to PayPal Store Sync when it opens up.
- Revenue-weighted priorities from PayPal transaction data: fix first the products that sell.

## Honest limits

PayPal runs in sandbox; no real money moves. Buyer requests are generated to be realistic for the product type, not logged searches. The ranking is a strict shopping-agent prompt over live competitor data, a proxy for ChatGPT, Gemini or Perplexity shopping. Amber & Aura is a sample store, and the demo owner’s answers are written by us and marked as such.
