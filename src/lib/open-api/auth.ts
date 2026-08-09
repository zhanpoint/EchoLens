import type { AuthUser } from "@/lib/auth/service";
import { readUserFromApiAccessToken } from "@/lib/api-access-tokens/service";

export async function requireOpenApiUser(request: Request): Promise<AuthUser | Response> {
  const user = await readUserFromApiAccessToken(readBearerToken(request));
  return user ?? Response.json(
    { code: "UNAUTHENTICATED", error: "API 访问令牌无效或已过期。" },
    { status: 401 },
  );
}

function readBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  return authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
}