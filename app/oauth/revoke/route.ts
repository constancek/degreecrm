import { revokeToken } from "@/lib/oauth/server";

// RFC 7009: always 200, even for unknown tokens.
export async function POST(req: Request) {
  const token = new URLSearchParams(await req.text()).get("token");
  if (token) await revokeToken(token);
  return new Response(null, { status: 200 });
}
