import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp/server";
import { verifyAccessToken } from "@/lib/oauth/server";
import { appUrl } from "@/lib/env";

export const maxDuration = 60;

// Stateless Streamable HTTP: a fresh server per request, so it runs fine on serverless.
async function handle(req: Request) {
  const user = await verifyAccessToken(req.headers.get("authorization"));
  if (!user) {
    return Response.json(
      { error: "invalid_token", error_description: "Sign in to the Degree of Comfort CRM" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${appUrl()}/.well-known/oauth-protected-resource/mcp"`,
        },
      },
    );
  }

  const server = buildMcpServer(user);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };
