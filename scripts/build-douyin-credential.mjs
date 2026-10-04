import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const helperSourceDir = resolve(root, "scripts", "douyin-credential-helper");
const publicDir = resolve(root, "public", "downloads");
const artifactManifest = JSON.parse(readFileSync(
  resolve(root, "src", "lib", "douyin", "credential-helper-artifacts.json"),
  "utf8",
));
const windowsTargets = Object.values(artifactManifest.windows);
const goBinary = resolveGoBinary();
const cleanEnv = { ...process.env };
delete cleanEnv.GOROOT;
const goRoot = execFileSync(goBinary, ["env", "GOROOT"], {
  encoding: "utf8",
  env: cleanEnv,
}).trim();
const baseEnv = { ...cleanEnv, CGO_ENABLED: "0", GOROOT: goRoot, GOOS: "windows" };

mkdirSync(publicDir, { recursive: true });

for (const target of windowsTargets) {
  const outputPath = resolve(publicDir, target.fileName);
  execFileSync(goBinary, [
    "build",
    "-trimpath",
    "-ldflags=-s -w",
    "-o",
    outputPath,
    ".",
  ], {
    cwd: helperSourceDir,
    env: { ...baseEnv, GOARCH: target.goArch },
    stdio: "inherit",
  });
  console.log(`Built ${outputPath}`);
}

if (process.argv.includes("--run")) {
  execFileSync(resolve(publicDir, artifactManifest.windows.x64.fileName), [], {
    stdio: "inherit",
  });
}

function resolveGoBinary() {
  const executable = process.platform === "win32" ? "go.exe" : "go";
  const candidates = [
    process.env.GO_BIN,
    ...(process.env.PATH || "").split(delimiter).map((entry) => join(entry, executable)),
  ].filter(Boolean);

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const cacheRoot = join(process.env.LOCALAPPDATA, "EchoLensTools");
    if (existsSync(cacheRoot)) {
      candidates.push(...readdirSync(cacheRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("go"))
        .map((entry) => join(cacheRoot, entry.name, "go", "bin", executable))
        .sort()
        .reverse());
    }
  }

  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) {
    throw new Error("Building credential helpers requires Go. Set GO_BIN or install Go from https://go.dev/dl/.");
  }
  return found;
}
