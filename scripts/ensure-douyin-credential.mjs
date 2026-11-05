import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(resolve(root, "src/lib/douyin/credential-helper-artifacts.json"), "utf8"));
const output = resolve(root, "public/downloads");

if (Object.values(manifest.windows).some(({ fileName }) => !existsSync(resolve(output, fileName)))) {
  const go = spawnSync("go", ["version"], { stdio: "ignore" });
  if (go.status === 0 || process.env.GO_BIN) {
    execFileSync(process.execPath, ["scripts/build-douyin-credential.mjs"], { cwd: root, stdio: "inherit" });
  } else {
    execFileSync("docker", ["build", "--target", "credential-helper-output", "--output", `type=local,dest=${output}`, "."], { cwd: root, stdio: "inherit" });
  }
}
