type Environment = Readonly<Record<string, string | undefined>>;

const LOCAL_BASE_URL = "http://localhost:3000";
const PRODUCTION_BASE_URL = "https://echolens.dreamlog.xyz";

export function getOpenApiBaseUrl(environment: Environment = process.env): string {
  return environment.PROD === "true" ? PRODUCTION_BASE_URL : LOCAL_BASE_URL;
}