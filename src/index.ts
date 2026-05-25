import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	ErrorCode,
	McpError
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{
		name: "perplexity-search",
		version: "1.0.0"
	},
	{
		capabilities: {
			tools: {}
		}
	}
);

// Reasoning models (sonar-reasoning-pro, sonar-deep-research) emit chain-of-thought
// wrapped in <think>...</think> inside message.content. Strip it so callers get a
// clean answer.
function stripThink(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

// Build the text payload: cleaned answer plus a compact Sources list from whichever
// grounding field Perplexity returned (search_results is richer than citations).
function formatResult(data: any): string {
	const raw = data?.choices?.[0]?.message?.content ?? "";
	let out = stripThink(typeof raw === "string" ? raw : String(raw));

	let sources: string[] = [];
	if (Array.isArray(data?.search_results)) {
		sources = data.search_results.map(
			(r: any, i: number) =>
				`[${i + 1}] ${r?.title ? `${r.title} — ` : ""}${r?.url ?? ""}`.trim()
		);
	} else if (Array.isArray(data?.citations)) {
		sources = data.citations.map(
			(c: any, i: number) =>
				`[${i + 1}] ${typeof c === "string" ? c : (c?.url ?? JSON.stringify(c))}`
		);
	}
	if (sources.length) {
		out += `\n\nSources:\n${sources.join("\n")}`;
	}
	return out;
}

async function callPerplexity(
	apiKey: string,
	model: string,
	query: string,
	extra: Record<string, unknown> = {}
): Promise<any> {
	const response = await fetch("https://api.perplexity.ai/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: query }],
			...extra
		})
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
		);
	}
	return response.json();
}

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: "perplexity_search",
				description:
					"Search the web using Perplexity (sonar-reasoning-pro: chain-of-thought reasoning + live web grounding). Fast (seconds); returns a cited answer. Use for everyday web research.",
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "The search query"
						}
					},
					required: ["query"]
				}
			},
			{
				name: "perplexity_deep_research",
				description:
					"Exhaustive multi-source research report via Perplexity sonar-deep-research. SLOW (tens of seconds to minutes) and costly (~$0.4-1.3 per query) — use ONLY when an in-depth report is explicitly wanted, never for quick lookups.",
				inputSchema: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "The research question"
						},
						reasoning_effort: {
							type: "string",
							enum: ["low", "medium", "high"],
							description:
								"Depth vs latency/cost. 'low' (default) ~30-60s; 'high' can take minutes and may exceed MCP client timeouts."
						}
					},
					required: ["query"]
				}
			}
		]
	};
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const apiKey = process.env.PERPLEXITY_API_KEY;
	if (!apiKey) {
		throw new McpError(
			ErrorCode.InvalidRequest,
			"PERPLEXITY_API_KEY environment variable is not set"
		);
	}

	const { name, arguments: args } = request.params;

	if (name !== "perplexity_search" && name !== "perplexity_deep_research") {
		throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
	}
	if (!args || typeof args.query !== "string") {
		throw new McpError(
			ErrorCode.InvalidParams,
			"Query parameter is required and must be a string"
		);
	}

	try {
		let data: any;
		if (name === "perplexity_search") {
			data = await callPerplexity(apiKey, "sonar-reasoning-pro", args.query);
		} else {
			const effort =
				typeof args.reasoning_effort === "string"
					? args.reasoning_effort
					: "low";
			data = await callPerplexity(apiKey, "sonar-deep-research", args.query, {
				reasoning_effort: effort
			});
		}
		return {
			content: [
				{
					type: "text",
					text: formatResult(data)
				}
			]
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		throw new McpError(
			ErrorCode.InternalError,
			`Perplexity request failed: ${errorMessage}`
		);
	}
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Perplexity MCP server running on stdio");
