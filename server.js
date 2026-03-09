const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// jobId -> { logs: [], clients: Set(res) }
const jobs = new Map();

function newJob() {
  const jobId = "job_" + Date.now() + "_" + Math.random().toString(16).slice(2);
  jobs.set(jobId, { logs: [], clients: new Set() });
  return jobId;
}

function pushLog(jobId, line) {
  const job = jobs.get(jobId);
  if (!job) return;

  const msg = String(line).replace(/\r?\n$/, "");
  job.logs.push(msg);

  for (const res of job.clients) {
    res.write(`data: ${msg.replace(/\n/g, " ")}\n\n`);
  }
}

function endJob(jobId, ok, errMsg) {
  if (errMsg) pushLog(jobId, "\n❌ " + errMsg);
  pushLog(jobId, ok ? "\n✅ Done" : "\n❌ Failed");

  const job = jobs.get(jobId);
  if (!job) return;

  for (const res of job.clients) res.end();
  job.clients.clear();
}

function runCmd(jobId, cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    pushLog(jobId, `\n> ${cmd} ${args.join(" ")}`);

    const child = spawn(cmd, args, {
      cwd,
      shell: true,        // important for windows
      windowsHide: true
    });

    child.stdout.on("data", (d) => pushLog(jobId, d.toString()));
    child.stderr.on("data", (d) => pushLog(jobId, d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed with code ${code}`));
    });
  });
}

// If base dir exists, create base-1, base-2, ...
function getAvailableDir(baseDir) {
  if (!fs.existsSync(baseDir)) return baseDir;
  let i = 1;
  while (true) {
    const candidate = `${baseDir}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

app.get("/health", (req, res) => res.send("OK"));

app.get("/logs", (req, res) => {
  const jobId = req.query.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).send("Unknown jobId");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // send existing logs first
  for (const line of job.logs) {
    res.write(`data: ${line.replace(/\n/g, " ")}\n\n`);
  }

  job.clients.add(res);
  req.on("close", () => job.clients.delete(res));
});

app.post("/deploy", async (req, res) => {
  const repoUrl = (req.body.repoUrl || "").trim();
  let targetDir = (req.body.targetDir || "").trim();
  const branch = (req.body.branch || "").trim();

  if (!repoUrl || !targetDir) {
    return res.status(400).send("repoUrl and targetDir required");
  }

  const jobId = newJob();
  res.json({ jobId });

  (async () => {
    try {
      // auto unique folder if exists
      const finalTargetDir = getAvailableDir(targetDir);
      pushLog(jobId, `Target folder: ${finalTargetDir}`);

      // Ensure parent exists (never create drive root)
      const parsed = path.parse(finalTargetDir);  // { root: 'E:\\', dir: 'E:\\_aasync', ... }
      const parent = path.dirname(finalTargetDir);

      if (parent !== parsed.root && !fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }

      // Clone
      pushLog(jobId, "Cloning...");
      const args = ["clone"];
      if (branch) args.push("-b", `"${branch}"`);
      args.push(`"${repoUrl}"`, `"${finalTargetDir}"`);
      await runCmd(jobId, "git", args, parent);

      // Composer install (recommended)
      pushLog(jobId, "Composer install...");
      await runCmd(jobId, "composer", ["update", "--no-interaction"], finalTargetDir);

      // .env setup
      const envExample = path.join(finalTargetDir, ".env.example");
      const envFile = path.join(finalTargetDir, ".env");

      if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
        pushLog(jobId, "Copying .env.example → .env");
        fs.copyFileSync(envExample, envFile);
      } else {
        pushLog(jobId, ".env exists (or .env.example missing) → skipping copy");
      }

      // Laravel key
      pushLog(jobId, "php artisan key:generate");
      await runCmd(jobId, "php", ["artisan", "key:generate"], finalTargetDir);

      // Start server in new window
      pushLog(jobId, "Starting: php artisan serve");
      await runCmd(
        jobId,
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Start-Process powershell -ArgumentList '-NoProfile','-Command','cd "${finalTargetDir}"; php artisan serve'`
        ],
        finalTargetDir
      );

      endJob(jobId, true);
    } catch (e) {
      endJob(jobId, false, e.message || String(e));
    }
  })();
});

app.listen(5050, "127.0.0.1", () => {
  console.log("✅ Deploy backend running: http://127.0.0.1:5050");
});