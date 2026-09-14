const $ = id => document.getElementById(id);

let currentTab = "file";
let currentJob = null;

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === btn));
    $("fileTab").classList.toggle("active", currentTab === "file");
    $("urlTab").classList.toggle("active", currentTab === "url");
  });
});

$("fileInput").addEventListener("change", () => {
  $("fileName").textContent = $("fileInput").files[0]?.name || "لم يتم اختيار ملف";
});

function setStatus(progress, text, detail = "") {
  $("status").classList.remove("hidden");
  $("statusText").textContent = text;
  $("progressText").textContent = `${progress}%`;
  $("bar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  $("detail").textContent = detail;
}

$("buildBtn").addEventListener("click", async () => {
  const file = $("fileInput").files[0];
  const url = $("urlInput").value.trim();

  if (currentTab === "file" && !file) {
    setStatus(0, "لم يتم اختيار ملف", "اختر مشروعًا أو ملفًا أولًا.");
    return;
  }
  if (currentTab === "url" && !url) {
    setStatus(0, "الرابط فارغ", "ضع رابط المشروع أو الصفحة.");
    return;
  }

  const fd = new FormData();
  if (file) fd.append("file", file);
  const icon = $("iconInput").files[0];
  if (icon) fd.append("icon", icon);
  if (url) fd.append("url", url);
  fd.append("appName", $("appName").value);
  fd.append("packageName", $("packageName").value);
  fd.append("versionName", $("versionName").value);

  $("buildBtn").disabled = true;
  $("downloadBtn").classList.add("hidden");
  setStatus(2, "جاري إرسال المصدر…");

  try {
    const res = await fetch("/api/build", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "فشل إرسال الطلب");
    currentJob = data.jobId;
    await poll();
  } catch (e) {
    setStatus(100, "فشل الطلب", e.message);
    $("buildBtn").disabled = false;
  }
});

async function poll() {
  const res = await fetch(`/api/job/${currentJob}`);
  const data = await res.json();

  setStatus(data.progress ?? 0, data.status === "done" ? "اكتمل البناء ✅" :
    data.status === "failed" ? "فشل البناء ❌" : "جاري البناء…", data.message || "");

  if (data.status === "done") {
    $("downloadBtn").href = data.download;
    $("downloadBtn").classList.remove("hidden");
    $("buildBtn").disabled = false;
    return;
  }

  if (data.status === "failed") {
    $("buildBtn").disabled = false;
    return;
  }

  setTimeout(poll, 1800);
}