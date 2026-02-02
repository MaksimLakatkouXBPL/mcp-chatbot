import express from 'express';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const mcpUrl = 'https://docs.dhtmlx.com/mcp';

function extractFirstSseDataJson(rawSseText) {
	const dataLine = rawSseText
		.split('\n')
		.find((line) => line.startsWith('data: '));

	if (!dataLine) {
		throw new Error(`No SSE data line found. Raw: ${rawSseText.slice(0, 500)}`);
	}

	const jsonText = dataLine.slice('data: '.length);
	return JSON.parse(jsonText);
}

async function mcpInitialize() {
	const response = await fetch(mcpUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: {
					name: 'chatbot-backend',
					version: '0.1.0',
				},
			},
		}),
	});

	const rawText = await response.text();

	if (!response.ok) {
		throw new Error(`MCP initialize failed: ${response.status} ${rawText}`);
	}

	const sessionId =
		response.headers.get('Mcp-Session-Id') ??
		response.headers.get('mcp-session-id');

	if (!sessionId) {
		throw new Error(`Missing Mcp-Session-Id header. Raw: ${rawText.slice(0, 500)}`);
	}

	extractFirstSseDataJson(rawText);
	return sessionId;
}

async function mcpInference({ sessionId, query, mode = 'generation', include = ['gantt'] }) {
	const response = await fetch(mcpUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			'Mcp-Session-Id': sessionId,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'Inference',
				arguments: {
					request: {
						query,
						mode,
						include,
					},
				},
			},
		}),
	});

	const rawText = await response.text();

	if (!response.ok) {
		throw new Error(`MCP tools/call failed: ${response.status} ${rawText}`);
	}

	const payload = extractFirstSseDataJson(rawText);

	const text =
		payload?.result?.content?.find((item) => item.type === 'text')?.text ??
		payload?.result?.structuredContent?.result ??
		null;

	if (!text) {
		throw new Error(`No text content in MCP response. Raw: ${rawText.slice(0, 500)}`);
	}

	return text;
}

app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

app.post('/api/chat', async (req, res) => {
	try {
		const message = String(req.body?.message ?? '').trim();

		if (!message) {
			return res.status(400).json({ error: 'message is required' });
		}

		const sessionId = await mcpInitialize();

		const answer = await mcpInference({
			sessionId,
			query: message,
			mode: 'generation',
			include: null,
		});

		res.json({ answer });
	} catch (error) {
		res.status(500).json({
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
	console.log(`Server is running on http://localhost:${port}`);
});
