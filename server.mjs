import express from 'express';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
	// Log only MCP-related paths to see what Lovable actually calls
	const isMcpProbe =
		req.path === '/' ||
		req.path === '/mcp' ||
		req.path === '/.well-known/mcp';

	if (!isMcpProbe) {
		return next();
	}

	console.log('lovable -> proxy', {
		method: req.method,
		path: req.path,
		accept: req.header('accept'),
		contentType: req.header('content-type'),
		mcpSessionId: req.header('mcp-session-id') ?? req.header('Mcp-Session-Id') ?? null,
		userAgent: req.header('user-agent'),
		body: req.body ?? null,
	});

	return next();
});

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

async function mcpInference({ sessionId, query, mode = 'generation', include = null }) {
	const request = {
		query,
		mode,
		...(include ? { include } : {}),
	};

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
					request,
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

const sessionMap = new Map();

function generateSessionId() {
	return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

async function callUpstreamMcp({ upstreamSessionId, rpc }) {
	const headers = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream',
	};

	if (upstreamSessionId) {
		headers['Mcp-Session-Id'] = upstreamSessionId;
	}

	const response = await fetch(mcpUrl, {
		method: 'POST',
		headers,
		body: JSON.stringify(rpc),
	});

	const rawText = await response.text();

	if (!response.ok) {
		throw new Error(`Upstream MCP error: ${response.status} ${rawText}`);
	}

	return {
		upstreamSessionId:
			response.headers.get('Mcp-Session-Id') ??
			response.headers.get('mcp-session-id') ??
			upstreamSessionId ??
			null,
		payload: extractFirstSseDataJson(rawText),
	};
}

function sendJson(res, payload, statusCode = 200) {
	const json = JSON.stringify(payload);

	res.status(statusCode);
	res.setHeader('Content-Type', 'application/json');
	res.setHeader('Content-Length', Buffer.byteLength(json));
	res.end(json);
}

app.get('/', (req, res) => {
	res.status(200).send('ok');
});

app.options('/', (req, res) => {
	res.status(204);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
	res.end();
});

app.post('/', (req, res, next) => {
	// Forward MCP POST / to the same handler as POST /mcp
	req.url = '/mcp';
	next();
});

app.get('/mcp', (req, res) => {
	res.status(200).send('ok');
});

app.get('/.well-known/mcp', (req, res) => {
	res.status(200).send('ok');
});

app.options('/.well-known/mcp', (req, res) => {
	res.status(204);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
	res.end();
});

app.post('/.well-known/mcp', (req, res, next) => {
	// Forward MCP POST /.well-known/mcp to the same handler as POST /mcp
	req.url = '/mcp';
	next();
});

app.options('/mcp', (req, res) => {
	res.status(204);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
	res.end();
});

app.post('/mcp', async (req, res) => {
	try {
		const rpc = req.body;

		if (!rpc || typeof rpc !== 'object' || typeof rpc.method !== 'string') {
			return sendJson(res, {
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Invalid Request' },
			}, 400);
		}

		const clientSessionId =
			req.header('Mcp-Session-Id') ??
			req.header('mcp-session-id') ??
			null;
			
		if (rpc.method.startsWith('notifications/')) {
			const upstreamSessionId = clientSessionId ? sessionMap.get(clientSessionId) : null;

			// No session yet -> still OK
			if (!upstreamSessionId) {
				return res.status(204).end();
			}

			await fetch(mcpUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					'Mcp-Session-Id': upstreamSessionId,
				},
				body: JSON.stringify(rpc),
			});

			res.setHeader('Mcp-Session-Id', clientSessionId);
			return res.status(204).end();
		}

		if (rpc.method === 'initialize') {
			const { upstreamSessionId, payload } = await callUpstreamMcp({
				upstreamSessionId: null,
				rpc,
			});

			if (!upstreamSessionId) {
				return sendJson(res, {
					jsonrpc: '2.0',
					id: rpc.id ?? null,
					error: { code: -32000, message: 'Upstream did not return Mcp-Session-Id' },
				}, 500);
			}

			const proxySessionId = generateSessionId();
			sessionMap.set(proxySessionId, upstreamSessionId);

			res.setHeader('Mcp-Session-Id', proxySessionId);
			return sendJson(res, payload);
		}

		const upstreamSessionId = clientSessionId ? sessionMap.get(clientSessionId) : null;

		if (!upstreamSessionId) {
			return sendJson(res, {
				jsonrpc: '2.0',
				id: rpc.id ?? null,
				error: {
					code: -32000,
					message: 'Missing or unknown Mcp-Session-Id. Call initialize first.',
				},
			}, 400);
		}

		const { payload } = await callUpstreamMcp({
			upstreamSessionId,
			rpc,
		});

		res.setHeader('Mcp-Session-Id', clientSessionId);
		return sendJson(res, payload);
	} catch (error) {
		return sendJson(res, {
			jsonrpc: '2.0',
			id: null,
			error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
		}, 500);
	}
});

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
