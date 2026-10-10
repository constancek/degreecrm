import { authorizationServerMetadata } from "@/lib/oauth/server";

export function GET() {
  return Response.json(authorizationServerMetadata(), { headers: { "access-control-allow-origin": "*" } });
}
