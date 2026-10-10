import { OAuthError, exchangeToken } from "@/lib/oauth/server";

export async function POST(req: Request) {
  try {
    const type = req.headers.get("content-type") ?? "";
    const form = type.includes("application/json")
      ? new URLSearchParams((await req.json()) as Record<string, string>)
      : new URLSearchParams(await req.text());
    return Response.json(await exchangeToken(form), {
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (err) {
    if (err instanceof OAuthError) return err.toResponse();
    throw err;
  }
}
