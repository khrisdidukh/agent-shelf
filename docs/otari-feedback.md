# Otari: what worked, what didn’t, and where we got stuck

Notes from building Agent Shelf’s Otari mode on the hosted gateway (EU region, `https://eu.api.otari.ai/api/v1`), 2 November 2026. Everything below was observed with real calls; request ids are included where they help.

## What worked well

- **OpenAI-compatible, really.** Swapping the base URL and key was enough for our plain `fetch` calls and for the Vercel AI SDK (`@ai-sdk/openai-compatible`) driving the PayPal Agent Toolkit’s tool calls through Mistral Large 3.
- **Response headers are the best part.** `Otari-Model`, `Otari-Provider`, `Otari-Fallback`, `Otari-Attempt-Count`, `Otari-Request-ID` and `Server-Timing` let us show, per card, which model and provider really answered. `meta/llama-3.3-70b-instruct` was served by Bedrock, `google/gemma-4-26b-a4b-it` and Qwen by DeepInfra, Mistral by Mistral: useful, and invisible without these headers.
- **Inline cost (`usage.cost_usd`) on every response.** It made a per-merchant spend ledger trivial; no separate usage query.
- **Open-weight catalog.** 117 models, and every role we needed had an open-weight option (Llama, Qwen, Gemma, Mistral, DeepSeek, Llama Guard 4).
- **Inline MCP (`mcp_servers`) worked first try** against a public Streamable HTTP MCP server (our own `/mcp` on Render, stateless), including `allowed_tools`.
- **Code execution (`otari_code_execution`) worked first try** with Mistral Small 4: the model wrote numpy, ran it, and answered with the result.
- **Request-supplied guardrail `url`.** Otari called our endpoint and, when it got a bad answer, failed closed in `block` mode (502) and served the request in `monitor` mode, as documented.
- **Clear refusals** in several places: the 421 for a wrong region names the right host, `/end-users` says it needs a service key, 429 carries `Otari-Error-Code: upstream_rate_limited`.

## Friction and problems

### 1. Region: `api.otari.ai` answers 421 for an EU key
`GET https://api.otari.ai/api/v1/models` with an EU key returns `421 {"detail":"This API key belongs to eu.api.otari.ai. Send the request there instead."}`. The message is good, but SDK clients don’t follow a 421, and the docs’ examples use the global host. A line in the quickstart (“EU accounts: use eu.api.otari.ai”) and the regional base URL shown next to the key in the dashboard would save the first debugging session.

### 2. `GET /tools` says web tools are available; requests say they are not
`GET /api/v1/tools` lists `otari_web_fetch` and `otari_web_search` with `"available": true`. A chat completion that declares them is refused:
- `{"type":"otari_web_fetch"}` → `403 {"detail":"web access is not enabled for this workspace"}` (request `4019fe30-e89b-4d46-a3a9-c4551c7af4e8`)
- `{"type":"otari_web_search","max_uses":1}` → `403 {"detail":"web search is not enabled for this workspace"}` (request `a3cc7d1b-39ec-4ccd-bbe2-bfa41e5f7c92`)
- `POST /api/v1/search` → `400 No search tools are configured. Add one on the dashboard's Tools & Guardrails page (or POST /api/v1/search-tools)…`

So `available` reflects the deployment, not the caller’s workspace. Reporting the workspace policy in `/tools` (or an `enabled_for_workspace` flag) would let an app hide or explain the feature instead of discovering it from a 403.

### 3. Hosted guardrails: no profile to use, and the header is missing `status`
- `guardrails: [{"profile":"prompt-injection","mode":"block"}]` → `502 guardrail profile 'prompt-injection' requested but no guardrails service is configured. Set OTARI_GUARDRAILS_URL on the gateway or pass url on the guardrail entry.` (request `e089fda2-540f-46bb-ab6a-fc6e05b4d14f`). A hosted customer can’t set a gateway env var; the message is written for operators.
- In `monitor` mode the response header was `Otari-Guardrails: [{"profile":"prompt-injection","mode":"monitor","valid":null,"score":null}]`. `docs/guardrails.md` says each entry carries `status` (`evaluated` / `inconclusive` / `unavailable`) and `reason` (`not_configured`), precisely so a caller can tell “didn’t run” from “ran, no verdict”. The hosted header has neither.
- `GET /api/v1/tool-settings/guardrails/profiles` needs the master key, so a tenant can’t discover which profiles exist; `/tool-settings/guardrails/catalog` is readable but lists guardrail types, not usable profiles.
- Guardrails check input only, and only the latest user message (`latest_user_text` in `api/routes/chat.py`); `output` is accepted but not enforced. Our case (“don’t let the analyst invent product facts”) is an output check, so we do it in code.

We ended up hosting our own guardrail service (Llama Guard 4 through Otari plus PII and prompt-injection checks) and passing its `url`, which works once the app has a public URL.

### 4. Gateway tool calls are not reported on the hosted gateway
`docs/api-reference.md` (“Gateway tool calls on Chat Completions”) says a chat completion carries `otari_tool_calls` with each web search, fetch, code run (code, stdout, exit code) and MCP call. On the hosted gateway, responses for code execution and for MCP had no `otari_tool_calls` field; `/responses` returned only the final message, no `code_interpreter_call` or MCP items. The only trace that the sandbox ran is the cost jump (about $0.01 per run) in `usage.cost_usd`. Web search, once enabled for the workspace, does return `otari_tool_calls` (query plus sources), so the gap is specific to code execution and MCP.

Repro: `POST /chat/completions` with `{"model":"mistralai/mistral-small-4","tools":[{"type":"otari_code_execution"}],"messages":[{"role":"user","content":"Use python to compute the percentile rank of 22 among [18,25,30,15,40,22,35]."}]}` → 200 with the right answer, `cost_usd` 0.010157, no `otari_tool_calls` (request `2eeaa2e3-dbf6-42f6-9967-49bb0b445776`). Same for `mcp_servers` (request `56f6c606-c237-451a-be65-5a3f226f0413`).

This may be docs on `main` running ahead of the deployed release (the CHANGELOG up to 0.35.0 doesn’t mention it, and `/health` doesn’t say which version is running). Either way, a version in `/health` and docs per release would help. Because of this we ask the model to return the code it ran and recompute every number in the app.

### 5. Bug: a truncated internal tool call is returned to the client
Repro: code execution with a `max_tokens` too small for the model to finish writing its code (61 prices in the prompt, `max_tokens: 700`, `max_tool_iterations: 3`, `mistralai/mistral-small-4`). Response (request `5a929697-c043-4974-b2d9-30c4a161c26e`): HTTP 200, `finish_reason: "length"`, `content: null`, and `message.tool_calls` holding Otari’s own internal `code_execution` function call with half-written `arguments`. The client never declared a function tool by that name, so it can’t do anything with it; in our app it looked like an empty answer. Expected: an error saying the model ran out of tokens inside a gateway tool call, or the internal call stripped from the message.

### 6. Responses API echoes Otari’s internal tool prompt
On `/api/v1/responses` with `otari_code_execution` and `mcp_servers`, the response’s `instructions` contained Otari’s injected tool hint (“You have access to the following tools: - code_execution: Prefer `code_execution` for any computation…”), and `tools` listed the internal function tools (`code_execution`, `product_gaps`) rather than what we sent (request `866b3dcb-b115-48f8-8eff-412f20728a91`). Not harmful, but surprising to find gateway prompt text in a response object.

### 7. Management with an API key: misleading 401
`GET /api/v1/organizations/me`, `/organizations/me/routing-policies`, `/organizations/me/budgets`, `/routing/policies`, `/budgets`, `/workspaces` with an ordinary API key all answer `401 {"detail":"Invalid master key"}`. The key is valid; the endpoint needs a dashboard session or the master key. “This endpoint needs a dashboard session or the master key” would be clearer. It also means an app can’t provision its own routing policies, budgets or service keys: per-user budgets need a manual dashboard step (create a service key and an end-user budget).

### 8. A model that hangs, and no gateway-side failover for it
`meta/llama-4-scout-17b` answered `429 upstream_rate_limited` (“Model busy, retry later”) in 3 s on one call (request `82024608-c191-4091-a643-0bce52a2cb6c`) and on others sent nothing until our client gave up (25 s in the app; one direct call over 60 s). As a catalog id it didn’t fail over to another provider, presumably because it has one offering. We handle it with our own chain (Llama 4 Scout → Llama 3.3 70B); a per-request timeout header, or a documented way to pass fallbacks per request without creating a dashboard policy, would make that Otari’s job.

### 9. Smaller things
- `alibaba/qwen3-32b` returned empty `content` with everything in `reasoning` for a short `max_tokens`; there’s no documented, provider-independent way to turn thinking off. We used instruct (non-thinking) models.
- `alibaba/qwen3-235b-a22b-instruct-2507` via DeepInfra took 10–60 s per call, so we lead the worker chain with Mistral Small 4 and keep Qwen behind it.
- `Otari-Guardrails` is only on non-streamed responses (documented).
- `max_tokens` on a tool-loop request bounds each round, not the whole loop (one request used 1,649 completion tokens with `max_tokens: 700`). Worth a sentence in `tools.md`.

## Dashboard steps we could not do with an API key (for this project)

1. Tools & Guardrails → Web search: turn web access on for the workspace (for `otari_web_fetch` / `otari_web_search`).
2. Spend & budgets: create an end-user budget; create a **service key** that starts its end users on it, then set `OTARI_SERVICE_KEY` and `OTARI_END_USER_BUDGET`.
3. Optional: Routing → create a Fallback policy and set `OTARI_POLICY_<ROLE>` to lead that role’s chain with it.
