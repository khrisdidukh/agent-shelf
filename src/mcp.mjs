// Agent Shelf as an MCP server, so other AI agents (a store's own assistant, a marketplace agent, Claude) can ask:
// "is this product ready to be bought by shopping agents, and what is missing?"
// Streamable HTTP, stateless: one server instance per request, mounted at /mcp by server.mjs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const pct = (x) => Math.round(x * 100) + '%';

export function mcpHandler({ storeReport, productReport }) {
  return async (req, res, body) => {
    const server = new McpServer({ name: 'agent-shelf', version: '1.0.0' });

    server.tool('shelf_readiness', 'Rank every product of a Shopify store by how much of what buyers ask shopping agents for its listing states. Weakest first.',
      { store_url: z.string().describe('Shopify store, e.g. https://candles.mock.shop') },
      async ({ store_url }) => {
        const a = await storeReport(store_url);
        const lines = a.rows.slice(0, 15).map((r) => `${pct(r.stated)}  ${r.title} (${r.id}) — missing: ${r.top.filter((t) => !t.stated).map((t) => t.need).join(', ') || 'nothing major'}`);
        return { content: [{ type: 'text', text: `${a.shop}: ${a.rows.length} products, agent-readable share of buyer needs, weakest first:\n${lines.join('\n')}` }] };
      });

    server.tool('product_gaps', 'For one product: in how many realistic buyer requests a shopping agent picks it, why it loses, and the questions the merchant must answer to fix the listing.',
      { store_url: z.string(), product: z.string().describe('Product handle, e.g. deep-orange-soy-candle') },
      async ({ store_url, product }) => {
        const r = await productReport(store_url, product);
        const s = r.score;
        const gaps = r.checks.filter((c) => !c.stated).map((c) => `- ${c.need}: ${c.count} of ${r.intents.length} buyers ask (e.g. "${c.examples[0]}")`);
        const lost = r.verdicts.filter((v) => v.rank > 1).map((v) => `- "${v.query}": ranked ${v.rank}/${v.of}. ${v.merchant_reason}`);
        return { content: [{ type: 'text', text: `Picked first in ${s.wins}/${s.requests} buyer requests; lost ${s.lostToMissing} only for missing facts.\n\nAsk the merchant about:\n${gaps.join('\n')}\n\nRequests lost:\n${lost.join('\n')}` }] };
      });

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
