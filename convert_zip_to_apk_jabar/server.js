import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);
const app = express();

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();
const UPLOADS = path.join(ROOT, "uploads");
const WORKSPACE = path.join(ROOT, "workspace");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const MAX_REMOTE = Number(process.env.MAX_REMOTE_MB || 2048) * 1024 * 1024;
const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT_MS || 60 * 60 * 1000);

for (const d of [UPLOADS, WORKSPACE]) fs.mkdirSync(d, { recursive: true });

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_UPLOAD }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));

const jobs = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function safeName(value, fallback = "تطبيقي") {
  const s = String(value || "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim();
  return s || fallback;
}

function safePackage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const parts = raw.split(".").filter(Boolean)
    .map(x => x.replace(/[^a-z0-9_]/g, ""))
    .filter(Boolean);
  if (parts.length >= 2 && parts.every(x => /^[a-z][a-z0-9_]*$/.test(x))) return parts.join(".");
  return `com.convertziptoapk.app${crypto.randomInt(100, 999)}`;
}

function safeVersionName(value) {
  const s = String(value || "1.0.0").trim().replace(/[^0-9A-Za-z._-]/g, "");
  return s || "1.0.0";
}

function isInside(root, target) {
  const a = path.resolve(root) + path.sep;
  const b = path.resolve(target);
  return b === path.resolve(root) || b.startsWith(a);
}

function safeExtract(zipPath, outDir) {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(outDir, entry.entryName);
    if (!isInside(outDir, target)) throw new Error("الملف المضغوط يحتوي على مسار غير آمن.");
  }
  zip.extractAllTo(outDir, true);
}

function walkFiles(root, visitor, max = 10000) {
  let seen = 0;
  function walk(dir, depth = 0) {
    if (seen >= max || depth > 12 || !fs.existsSync(dir)) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= max) return;
      if ([".git", ".gradle", "node_modules", "build", ".dart_tool", ".idea", "dist-cache"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { seen++; visitor(p); }
    }
  }
  walk(root);
}

function findFile(root, names) {
  const wanted = new Set(names.map(x => x.toLowerCase()));
  let hit = null;
  walkFiles(root, p => {
    if (!hit && wanted.has(path.basename(p).toLowerCase())) hit = p;
  });
  return hit;
}

function findDirWith(root, dirName) {
  let hit = null;
  walkFiles(root, p => {
    if (hit) return;
    if (path.basename(path.dirname(p)).toLowerCase() === dirName.toLowerCase()) hit = path.dirname(p);
  });
  return hit;
}

function detectProject(root) {
  const settings = findFile(root, ["settings.gradle", "settings.gradle.kts"]);
  const gradlew = findFile(root, ["gradlew"]);
  const pubspec = findFile(root, ["pubspec.yaml"]);
  const packageJson = findFile(root, ["package.json"]);
  const capacitor = findFile(root, ["capacitor.config.ts", "capacitor.config.js", "capacitor.config.json"]);
  const index = findFile(root, ["index.html"]);
  const androidManifest = findFile(root, ["AndroidManifest.xml"]);
  const webCandidates = ["dist", "build", "www", "public", "src"];

  if (settings || gradlew || androidManifest) return { type: "android", root: settings ? path.dirname(settings) : root };
  if (pubspec) return { type: "flutter", root: path.dirname(pubspec) };
  if (capacitor) return { type: "capacitor", root: path.dirname(capacitor) };
  if (packageJson) {
    try {
      const obj = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      const deps = { ...(obj.dependencies || {}), ...(obj.devDependencies || {}) };
      if (deps["react-native"]) {
        const android = path.join(path.dirname(packageJson), "android");
        if (fs.existsSync(android)) return { type: "react-native", root: path.dirname(packageJson) };
      }
      if (index || webCandidates.some(d => fs.existsSync(path.join(path.dirname(packageJson), d, "index.html")))) {
        return { type: "web", root: path.dirname(packageJson) };
      }
    } catch {}
  }
  if (index) return { type: "web", root: path.dirname(index) };
  return { type: "unknown", root };
}

function findWebRoot(root) {
  const direct = path.join(root, "index.html");
  if (fs.existsSync(direct)) return root;
  for (const name of ["dist", "build", "www", "public", "src"]) {
    const p = path.join(root, name, "index.html");
    if (fs.existsSync(p)) return path.join(root, name);
  }
  const index = findFile(root, ["index.html"]);
  return index ? path.dirname(index) : null;
}

function runCmd(cwd, command, args, timeout = BUILD_TIMEOUT) {
  return execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, CI: process.env.CI || "1" }
  });
}

function commandExists(command) {
  return new Promise(resolve => {
    execFile(command, ["--version"], { timeout: 5000 }, err => resolve(!err));
  });
}

function setJob(job, patch) {
  Object.assign(job, patch);
}

async function downloadUrl(url, outPath) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("الرابط يجب أن يبدأ بـ http:// أو https://");

  const res = await fetch(target, { redirect: "follow" });
  if (!res.ok) throw new Error(`فشل تنزيل الرابط: HTTP ${res.status}`);

  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > MAX_REMOTE) throw new Error("الحجم عبر الرابط أكبر من الحد المسموح.");

  const file = fs.createWriteStream(outPath);
  let total = 0;
  const body = Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    body.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_REMOTE) {
        body.destroy(new Error("تجاوز الحجم الأقصى للرابط."));
      }
    });
    body.on("error", reject);
    file.on("error", reject);
    file.on("finish", resolve);
    body.pipe(file);
  });
  return outPath;
}

function isGitHubRepoUrl(value) {
  try {
    const u = new URL(value);
    return u.hostname.toLowerCase() === "github.com" && /^\/[^/]+\/[^/]+\/?$/.test(u.pathname);
  } catch { return false; }
}

async function downloadSourceUrl(url, outPath) {
  if (isGitHubRepoUrl(url)) {
    const u = new URL(url);
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    const branches = [`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/main`,
                      `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`];
    for (const candidate of branches) {
      try {
        return await downloadUrl(candidate, outPath);
      } catch {}
    }
  }
  return await downloadUrl(url, outPath);
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copyDirContents(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function writeIcon(iconPath, wrapperRoot) {
  if (!iconPath) return;
  const resDirs = ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"];
  for (const r of resDirs) {
    const d = path.join(wrapperRoot, "app/src/main/res", r);
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(iconPath, path.join(d, "ic_launcher.png"));
  }
}

function applyBasicAndroidMetadata(root, appName, packageName, versionName) {
  walkFiles(root, p => {
    const n = path.basename(p).toLowerCase();
    if (!/\.(gradle|gradle\.kts|xml|properties|kt|java|kts)$/.test(n)) return;
    try {
      let s = fs.readFileSync(p, "utf8");
      s = s.replace(/applicationId\s*[=:]\s*["'][^"']+["']/g, `applicationId "${packageName}"`);
      s = s.replace(/namespace\s*[=:]\s*["'][^"']+["']/g, `namespace "${packageName}"`);
      s = s.replace(/rootProject\.name\s*=\s*["'][^"']+["']/g, `rootProject.name = "${appName.replace(/"/g, "")}"`);
      s = s.replace(/versionName\s+[\"'][^\"']+[\"']/g, `versionName "${versionName}"`);
      fs.writeFileSync(p, s);
    } catch {}
  });
}

async function buildExistingAndroid(root, job) {
  const gradlew = findFile(root, ["gradlew"]);
  if (!gradlew) {
    const gradle = process.env.GRADLE_CMD || "gradle";
    if (!(await commandExists(gradle))) {
      throw new Error("لم أجد Gradle Wrapper أو أمر gradle في الخادم.");
    }
    job.message = "مشروع Android بدون Gradle Wrapper؛ سأستخدم Gradle المثبت على الخادم…";
    await runCmd(root, gradle, ["assembleDebug", "--no-daemon", "--stacktrace"]);
  } else {
    if (process.platform !== "win32") fs.chmodSync(gradlew, 0o755);
    job.message = "جاري بناء مشروع Android الأصلي…";
    await runCmd(root, gradlew, ["assembleDebug", "--no-daemon", "--stacktrace"]);
  }

  let apk = null;
  walkFiles(root, p => {
    if (!apk && p.toLowerCase().endsWith(".apk")) apk = p;
  });
  if (!apk) throw new Error("انتهى البناء بدون العثور على APK.");
  return apk;
}

async function buildFlutter(root, job) {
  if (!(await commandExists("flutter"))) throw new Error("مشروع Flutter detected لكن Flutter SDK غير مثبت على الخادم.");
  job.message = "جاري تثبيت حزم Flutter…";
  await runCmd(root, "flutter", ["pub", "get"]);
  job.message = "جاري بناء Flutter APK…";
  await runCmd(root, "flutter", ["build", "apk", "--debug"]);
  const apk = findFile(root, ["app-debug.apk"]);
  if (!apk) throw new Error("Flutter انتهى بدون app-debug.apk.");
  return apk;
}

async function buildReactNative(root, job) {
  const android = path.join(root, "android");
  const gradlew = path.join(android, "gradlew");
  if (!fs.existsSync(gradlew)) throw new Error("مشروع React Native لا يحتوي android/gradlew.");
  if (process.platform !== "win32") fs.chmodSync(gradlew, 0o755);
  job.message = "جاري تثبيت حزم React Native…";
  const packageManager = fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
  if (await commandExists(packageManager)) {
    await runCmd(root, packageManager, ["install"], 45 * 60 * 1000);
  }
  job.message = "جاري بناء React Native APK…";
  await runCmd(android, gradlew, ["assembleDebug", "--no-daemon", "--stacktrace"], BUILD_TIMEOUT);
  const apk = findFile(android, ["app-debug.apk"]);
  if (!apk) throw new Error("React Native انتهى بدون APK.");
  return apk;
}

async function buildCapacitor(root, job) {
  if (!(await commandExists("npx"))) throw new Error("npx غير مثبت.");
  job.message = "جاري تجهيز Capacitor Android…";
  await runCmd(root, "npx", ["cap", "sync", "android"], BUILD_TIMEOUT);
  return buildExistingAndroid(path.join(root, "android"), job);
}

function createViewerWebRoot(job, inputPath, originalName, mode = "file") {
  const web = path.join(job.temp, "generated-web");
  fs.mkdirSync(web, { recursive: true });
  const ext = path.extname(originalName).toLowerCase();
  const targetName = `source${ext || ".bin"}`;
  fs.copyFileSync(inputPath, path.join(web, targetName));

  let body = "";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    body = `<img src="${targetName}" alt="file">`;
  } else if ([".txt", ".md", ".json", ".csv", ".xml", ".yaml", ".yml", ".log"].includes(ext)) {
    const text = fs.readFileSync(inputPath, "utf8").replace(/[&<>]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]));
    body = `<pre>${text}</pre>`;
  } else if (ext === ".pdf") {
    body = `<iframe src="${targetName}" title="PDF"></iframe><a class="download" href="${targetName}" download>تنزيل الملف</a>`;
  } else {
    body = `<div class="unknown"><h2>ملف مرفق</h2><p>اسم الملف: ${originalName}</p><a class="download" href="${targetName}" download>فتح / تنزيل الملف</a></div>`;
  }

  writeText(path.join(web, "index.html"), `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>تحويل من ملف إلى APK</title>
<style>
body{margin:0;background:#0b1111;color:#f3eee3;font-family:system-ui;padding:20px}
main{max-width:1000px;margin:auto}h1{color:#d6a84f}
img{max-width:100%;max-height:80vh;border-radius:18px}pre{white-space:pre-wrap;background:#121a1a;padding:16px;border-radius:14px}iframe{width:100%;height:80vh;border:0;background:white;border-radius:16px}.download{display:inline-block;margin-top:14px;padding:12px 16px;background:#d6a84f;color:#151515;border-radius:12px;text-decoration:none}
</style></head><body><main><h1>تحويل من ملف إلى APK</h1>${body}</main></body></html>`);
  return web;
}

function makeWrapper(wrapper, appName, packageName, versionName, webRoot, remoteUrl = null, iconPath = null) {
  const pkgPath = packageName.split(".");
  const javaDir = path.join(wrapper, "app/src/main/java", ...pkgPath);
  fs.mkdirSync(javaDir, { recursive: true });
  for (const d of [
    "app/src/main/res/values", "app/src/main/res/mipmap-mdpi", "app/src/main/res/mipmap-hdpi",
    "app/src/main/res/mipmap-xhdpi", "app/src/main/res/mipmap-xxhdpi", "app/src/main/res/mipmap-xxxhdpi",
    "app/src/main/assets"
  ]) fs.mkdirSync(path.join(wrapper, d), { recursive: true });

  writeText(path.join(wrapper, "settings.gradle"), `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name='${appName.replace(/'/g,"")}'
include ':app'
`);
  writeText(path.join(wrapper, "build.gradle"), `plugins { id 'com.android.application' version '8.7.3' apply false }\n`);
  writeText(path.join(wrapper, "gradle.properties"), `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\n`);
  writeText(path.join(wrapper, "app/build.gradle"), `plugins { id 'com.android.application' }
android { namespace '${packageName}'; compileSdk 35
  defaultConfig { applicationId '${packageName}'; minSdk 23; targetSdk 35; versionCode 1; versionName '${versionName}' }
}\n`);
  writeText(path.join(wrapper, "app/src/main/res/values/strings.xml"),
    `<resources><string name="app_name">${appName.replace(/[<&>]/g,"")}</string></resources>`);
  writeText(path.join(wrapper, "app/src/main/res/values/styles.xml"),
    `<resources><style name="AppTheme" parent="android:style/Theme.Material.NoActionBar"><item name="android:fontFamily">sans</item><item name="android:colorAccent">#D6A84F</item><item name="android:statusBarColor">#0b1111</item><item name="android:navigationBarColor">#0b1111</item></style></resources>`);
  writeText(path.join(wrapper, "app/src/main/AndroidManifest.xml"),
`<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<uses-permission android:name="android.permission.INTERNET"/>
<application android:theme="@style/AppTheme" android:label="@string/app_name" android:usesCleartextTraffic="true" android:resizeableActivity="true">
<activity android:name=".MainActivity" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`);

  const load = remoteUrl
    ? `webView.loadUrl("${remoteUrl.replace(/\\/g,"\\\\").replace(/"/g,'\\"')}");`
    : `webView.loadUrl("file:///android_asset/index.html");`;

  writeText(path.join(javaDir, "MainActivity.java"), `package ${packageName};
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class MainActivity extends Activity {
 @Override public void onCreate(Bundle b){super.onCreate(b); WebView w=new WebView(this); w.setWebViewClient(new WebViewClient());
 WebSettings s=w.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setAllowFileAccess(true); s.setAllowContentAccess(true);
 s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE); ${load} setContentView(w);}
}
`);
  if (remoteUrl) {
    writeText(path.join(wrapper, "app/src/main/assets/README.txt"), `Remote URL wrapper: ${remoteUrl}\n`);
  } else {
    copyDirContents(webRoot, path.join(wrapper, "app/src/main/assets"));
  }
  if (iconPath) writeIcon(iconPath, wrapper);
}

async function buildWeb(wrapper, job) {
  const gradle = process.env.GRADLE_CMD || "gradle";
  if (!(await commandExists(gradle))) throw new Error("Gradle غير مثبت على الخادم.");
  job.message = "جاري بناء Web/PWA داخل تطبيق Android…";
  await runCmd(wrapper, gradle, ["assembleDebug", "--no-daemon", "--stacktrace"], BUILD_TIMEOUT);
  const apk = path.join(wrapper, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
  if (!fs.existsSync(apk)) throw new Error("فشل بناء WebView APK.");
  return apk;
}

async function prepareInput(inputPath, originalName, job) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".zip") {
    const temp = path.join(job.temp, "source");
    fs.mkdirSync(temp, { recursive: true });
    job.message = "جاري فك ZIP وفحص المشروع…";
    safeExtract(inputPath, temp);
    return { kind: "project", root: temp };
  }
  if ([".apk"].includes(ext)) {
    throw new Error("ملف APK الناتج ليس مشروعًا مصدرًا؛ ارفع المشروع المصدر أو ZIP الخاص به.");
  }
  return { kind: "single", path: inputPath, name: originalName };
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "convert-zip-to-apk-jabar", version: "2.0.0" });
});

app.get("/api/capabilities", async (req, res) => {
  res.json({
    upload: true,
    url: true,
    githubRepoUrl: true,
    supported: ["Android Gradle", "Flutter", "React Native", "Capacitor/Ionic", "Web/HTML/CSS/JS", "PWA", "PDF", "Images", "Text/Data"],
    bestEffort: true
  });
});

app.post("/api/build", upload.fields([{ name: "file", maxCount: 1 }, { name: "icon", maxCount: 1 }]), async (req, res) => {
  const file = req.files?.file?.[0];
  const icon = req.files?.icon?.[0];
  const url = String(req.body?.url || "").trim();
  if (!file && !url) return res.status(400).json({ error: "ارفع ملفًا أو ضع رابط مشروع." });

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId, status: "queued", progress: 0,
    message: "تم استلام الطلب…", apk: null, error: null,
    temp: path.join(WORKSPACE, jobId)
  };
  jobs.set(jobId, job);
  fs.mkdirSync(job.temp, { recursive: true });
  res.json({ jobId });

  (async () => {
    try {
      setJob(job, { status: "working", progress: 5 });

      let sourcePath;
      let originalName;

      if (file) {
        sourcePath = file.path;
        originalName = file.originalname || "source";
      } else {
        sourcePath = path.join(job.temp, "remote-source");
        job.message = "جاري تنزيل المصدر من الرابط…";
        await downloadSourceUrl(url, sourcePath);
        originalName = new URL(url).pathname.split("/").pop() || "remote-source";
        if (!path.extname(originalName)) {
          const u = new URL(url);
          if (isGitHubRepoUrl(url)) originalName += ".zip";
          else originalName += ".html";
        }
      }

      const name = safeName(req.body?.appName, "تطبيقي");
      const pkg = safePackage(req.body?.packageName);
      const versionName = safeVersionName(req.body?.versionName);

      setJob(job, { progress: 15 });

      if (url && !isGitHubRepoUrl(url) && !url.toLowerCase().endsWith(".zip")) {
        const wrapper = path.join(job.temp, "remote-wrapper");
        makeWrapper(wrapper, name, pkg, versionName, null, url, icon?.path);
        job.message = "الرابط ليس مستودعًا؛ سأحوّله إلى تطبيق WebView مباشر…";
        setJob(job, { progress: 35 });
        job.apk = await buildWeb(wrapper, job);
      } else {
        const prepared = await prepareInput(sourcePath, originalName, job);

        if (prepared.kind === "single") {
          job.message = "جاري إنشاء تطبيق عارض لهذا الملف…";
          const webRoot = createViewerWebRoot(job, prepared.path, prepared.name);
          const wrapper = path.join(job.temp, "file-wrapper");
          makeWrapper(wrapper, name, pkg, versionName, webRoot, null, icon?.path);
          setJob(job, { progress: 40 });
          job.apk = await buildWeb(wrapper, job);
        } else {
          const project = detectProject(prepared.root);
          setJob(job, { progress: 25, message: `تم التعرف على نوع المشروع: ${project.type}` });

          if (project.type === "android") {
            applyBasicAndroidMetadata(project.root, name, pkg, versionName);
            job.message = "تخصيص بيانات التطبيق والأيقونة…";
            if (icon?.path) writeIcon(icon.path, project.root);
            setJob(job, { progress: 40 });
            job.apk = await buildExistingAndroid(project.root, job);
          } else if (project.type === "flutter") {
            setJob(job, { progress: 35 });
            job.apk = await buildFlutter(project.root, job);
          } else if (project.type === "react-native") {
            setJob(job, { progress: 35 });
            job.apk = await buildReactNative(project.root, job);
          } else if (project.type === "capacitor") {
            setJob(job, { progress: 35 });
            job.apk = await buildCapacitor(project.root, job);
          } else if (project.type === "web") {
            const webRoot = findWebRoot(project.root);
            if (!webRoot) throw new Error("تم تصنيف المشروع Web لكن index.html غير موجود.");
            const wrapper = path.join(job.temp, "web-wrapper");
            makeWrapper(wrapper, name, pkg, versionName, webRoot, null, icon?.path);
            setJob(job, { progress: 40 });
            job.apk = await buildWeb(wrapper, job);
          } else {
            throw new Error("لم أجد محرك بناء مناسب لهذا المشروع. المشاريع المدعومة: Android Gradle, Flutter, React Native, Capacitor/Ionic, Web/PWA.");
          }
        }
      }

      const finalApk = path.join(job.temp, `${name.replace(/\s+/g, "_")}.apk`);
      fs.copyFileSync(job.apk, finalApk);
      job.apk = finalApk;
      setJob(job, { status: "done", progress: 100, message: "اكتمل البناء بنجاح ✅" });
    } catch (e) {
      setJob(job, { status: "failed", progress: 100, error: String(e?.message || e), message: "فشل البناء." });
    } finally {
      try {
        if (file?.path) fs.rmSync(file.path, { force: true });
      } catch {}
    }
  })();
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "البناء غير موجود." });
  res.json({
    id: job.id, status: job.status, progress: job.progress,
    message: job.status === "failed" ? job.error : job.message,
    download: job.status === "done" ? `/api/job/${job.id}/apk` : null
  });
});

app.get("/api/job/:id/apk", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.apk || !fs.existsSync(job.apk)) {
    return res.status(404).send("APK غير جاهز.");
  }
  res.download(job.apk, path.basename(job.apk));
});

app.listen(PORT, () => {
  console.log(`Convert ZIP to APK Jabar listening on :${PORT}`);
});

// تنظيف الذاكرة القديمة كل 30 دقيقة
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.status !== "working" && job.createdAt && job.createdAt < cutoff) {
      jobs.delete(id);
      fs.rmSync(job.temp, { recursive: true, force: true });
    }
  }
}, 30 * 60 * 1000);

for (const job of jobs.values()) job.createdAt = job.createdAt || Date.now();
