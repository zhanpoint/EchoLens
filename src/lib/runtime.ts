export function isProdRuntime(): boolean {
  return process.env.PROD?.trim().toLowerCase() === "true";
}
