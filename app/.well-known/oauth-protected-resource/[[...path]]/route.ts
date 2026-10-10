import { protectedResourceMetadata } from "@/lib/oauth/server";

// Served at both /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/mcp.
export function GET() {
  return Response.json(protectedResourceMetadata(), { headers: { "access-control-allow-origin": "*" } });
}
