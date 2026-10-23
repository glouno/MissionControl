import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
export const launchFrame = "MC_NATIVE_LAUNCH_V1\n";
/** Wait for controller-owned execution identity to be durable before launching work.
 * This helper never opens the application DB and carries no controller token. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    // EOF after a controller crash is not permission to launch an empty prompt.
    if (!input.startsWith(launchFrame)) {
      process.exitCode = 1;
      return;
    }
    input = input.slice(launchFrame.length);
    const child = spawn(process.argv[2], process.argv.slice(3), {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      process.stderr.write("Native executable could not start\n");
      process.exitCode = 1;
    });
    child.on("close", (code) => {
      process.exitCode = code ?? 1;
    });
    child.stdin.end(input);
  });
}
