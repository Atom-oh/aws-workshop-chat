// Minimal MCP client for the AWS Knowledge MCP Server (https://knowledge-mcp.global.api.aws) —
// a fully managed, keyless, read-only MCP endpoint AWS operates for AWS documentation search
// (GA Oct 2025). No IAM/SigV4 needed, so this is a plain JSON-RPC-over-HTTP client, not a full
// MCP SDK dependency. The endpoint is the bare origin — no /mcp path (that variant 400s on
// tools/call while still answering initialize/tools/list, which is what made this look broken).
const ENDPOINT = "https://knowledge-mcp.global.api.aws";
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

let sessionId: string | null = null;

async function initSession(): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "workshop-chat", version: "1.0.0" } },
    }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (!sid) throw new Error("AWS Knowledge MCP: no session established");
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...HEADERS, "Mcp-Session-Id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sid;
}

async function callTool(name: string, args: Record<string, unknown>, retrying = false): Promise<string> {
  if (!sessionId) sessionId = await initSession();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...HEADERS, "Mcp-Session-Id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.status === 404 && !retrying) {
    // session expired — re-handshake once
    sessionId = null;
    return callTool(name, args, true);
  }
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "AWS Knowledge MCP error");
  const content = body.result?.content ?? [];
  return content.map((c: any) => c.text ?? "").join("\n");
}

export function searchAwsDocs(query: string): Promise<string> {
  return callTool("aws___search_documentation", { search_phrase: query, limit: 4 });
}

export function readAwsDoc(url: string): Promise<string> {
  return callTool("aws___read_documentation", { requests: [{ url, max_length: 5000 }] });
}
