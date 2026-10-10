import { OAuthError, registerClient } from "@/lib/oauth/server";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => {
      throw new OAuthError("invalid_client_metadata", "Body must be JSON");
    });
    return Response.json(await registerClient(body), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof OAuthError) return err.toResponse();
    throw err;
  }
}
