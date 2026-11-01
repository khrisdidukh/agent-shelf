# Agent Shelf

**Shopping agents can’t buy what your listing doesn’t say.**

Buyers have started asking AI agents to find and buy things for them (“a soy candle for my mom, lavender, gift-wrapped, under $30”). The agent can only choose a product whose listing *states* those facts. Most small shops write descriptions for people looking at a photo, so agents skip them.

Agent Shelf is a tool for merchants. It reads a store the way shopping agents do, shows which buyer requests each product loses and why, fills the gaps **only with facts the merchant confirms**, re-tests the listing, publishes it to the merchant’s PayPal catalog, and lets a real AI agent buy it through PayPal.

- Live demo: https://agent-shelf.onrender.com (free hosting: the first load after a quiet period can take ~1 minute)
- Demo video: _link added on submission_
- MCP endpoint for other agents: `https://agent-shelf.onrender.com/mcp`

## Try it (3 minutes)

1. Open the live demo. It loads **Amber & Aura**, a public sample store from Shopify’s [mock.shop](https://mock.shop) (30 products: candles, incense, vases, lamps).
   **See:** a table (AG Grid) of every product, weakest first, with the share of buyer needs its listing states and which needs are missing.
2. Click **Deep Orange Soy Candle**.
   **See:** “Picked first in 0 of 8 buyer requests. Lost 7 only because the listing doesn’t say enough.” On the left, what a shopper sees; on the right, what an agent can use (scent, size, burn time… “not stated”). Switch to **Agent data** to see what competing products (live, from Channel3) carry: e.g. most of them state scent and dimensions.
3. Scroll to **Questions only you can answer**, press **Fill the demo owner’s answers** (or type your own), then **Rewrite for agents and test again**.
   **See:** a new title and attributes, each with the merchant’s words it came from; “lost for missing facts” drops from 7 to 1; the remaining losses are honest misfits (a buyer who wants lavender).
4. In **Let a shopping agent buy it**, press **Send the agent shopping**.
   **See:** the agent’s decision, the `create_order` call it made through the **PayPal Agent Toolkit**, and a PayPal sandbox order `PAYER_ACTION_REQUIRED`. Press **Approve as the buyer** and log in with a PayPal sandbox personal account; PayPal returns to `/paid` and Agent Shelf captures the payment (`COMPLETED`, with capture id).
5. Optional: **Publish listing to PayPal catalog** creates the product in the merchant’s PayPal Catalog Products API (sandbox) and shows its `PROD-…` id.
6. Optional: put any Shopify store URL with a public `/products.json` feed in the top field.

## How it works

| Step | What happens | Where |
| --- | --- | --- |
| Import | Products from Shopify (mock.shop Storefront GraphQL, or a store’s public `/products.json`) | `src/shopify.mjs` |
| Buyer needs | The model names the product type the way shoppers search (“soy candle”) and writes 8 realistic requests real buyers send to agents, with their hard needs in a shared vocabulary | `src/shelf.mjs` `genericType`, `buyerIntents` |
| Agent data | Each request is run against Channel3’s universal product catalog: the live field an agent would see. Agent Shelf measures which fields competing products carry | `src/channel3.mjs`, `agentNeeds` |
| Is it stated? | For each need, the model must quote the listing word for word; **code checks the quote exists**, otherwise the need counts as not stated | `checkListing` |
| Agent verdict | A shopping-agent prompt ranks the listing against the top 5 live competitors per request and says why: *fits*, *missing facts* or *not a fit* | `rankAsAgent` |
| Fix | Missing needs become questions to the merchant. Attributes are written only from the merchant’s answers, and **each must quote the answer**; unquoted values are dropped and turned back into questions | `proposeFixes` |
| Re-test | Same requests, same competitors, new listing | `src/run.mjs` `improve` |
| PayPal | Catalog Products API (publish), Orders v2 (agent order, buyer approval, capture), PayPal Agent Toolkit (`create_order` as an LLM tool) | `src/paypal.mjs`, `src/buyer-agent.mjs` |
| MCP | `shelf_readiness` and `product_gaps` tools over Streamable HTTP so other agents can query a store | `src/mcp.mjs` |

Model: Qwen3.8-27B on NEAR AI Cloud through its OpenAI-compatible API (any OpenAI-compatible endpoint works: set `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`). Calls run at temperature 0 and are cached by prompt hash, so a demo run is repeatable.

### Why “quote or it didn’t happen”

An AI that writes product copy will happily invent a burn time. That is a liability for the merchant and poison for agents. Agent Shelf never lets the model add a fact on its own: every “stated” need quotes the listing, every new attribute quotes the merchant, and both quotes are verified by plain string matching in code.

## Run it locally

```sh
git clone https://github.com/khrisdidukh/agent-shelf && cd agent-shelf
npm ci
cp .env.example .env   # fill in the keys below
node server.mjs        # http://localhost:8790
```

| Variable | Where to get it |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com → Apps & Credentials → **Sandbox** → Create App (type Merchant) |
| `CHANNEL3_API_KEY` | trychannel3.com → developer sign-up |
| `NEARAI_API_KEY` (or `AI_API_KEY` + `AI_BASE_URL` + `AI_MODEL`) | cloud.near.ai, or any OpenAI-compatible provider |
| `PUBLIC_URL` | where PayPal should return the buyer, e.g. `http://localhost:8790` |

The repository includes recorded results for the demo store (`cache/reports`, `cache/channel3`), so the demo product opens instantly; a new product or store runs live (about a minute per product).

Buyer approval needs a PayPal **sandbox personal account**: developer.paypal.com → Testing Tools → Sandbox Accounts (one is created for you).

Test the MCP endpoint:

```sh
curl -s -X POST http://localhost:8790/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"product_gaps","arguments":{"store_url":"https://candles.mock.shop","product":"deep-orange-soy-candle"}}}'
```

## Built with

- PayPal: Orders v2, Catalog Products API, PayPal Agent Toolkit (`@paypal/agent-toolkit`, Vercel AI SDK adapter), sandbox
- Channel3 (`@channel3/sdk`): live product search, the field agents see
- AG Grid Community: the store table
- Shopify mock.shop: public demo store data
- Qwen3.8-27B on NEAR AI Cloud; Vercel AI SDK; Model Context Protocol SDK
- Hosting: Render

All code was written during the hackathon (November 2026).

## Honest limits

- PayPal runs in **sandbox**; no real money moves.
- “Buyer requests” are generated by a model to be realistic for the product type; they are not logged searches from a real agent platform.
- The ranking is a strict shopping-agent prompt over live competitor data, a proxy for how ChatGPT, Gemini or Perplexity shopping behave, not their actual ranking.
- PayPal’s own channel for publishing catalogs to AI agents (Store Sync) is currently limited to US merchants by request; Agent Shelf prepares listings for it and publishes to the Catalog Products API instead.
- The demo owner’s answers for the demo product are written by us and marked as such; Amber & Aura is a sample store, not a real business.

## License

MIT
