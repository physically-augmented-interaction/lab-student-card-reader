
const monthInput = document.querySelector("#month");
const now = new Date();
monthInput.value = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function uploadSound(path, file) {
  if (!file) return;
  const response = await fetch(path, {
    method: "PUT",
    headers: { "content-type": file.type || "audio/mpeg" },
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
}

function summaryCard(label, value) {
  return '<div class="card">' + label + "<b>" + value + "</b></div>";
}

async function loadDashboard() {
  const data = await api("/api/dashboard?month=" + encodeURIComponent(monthInput.value));
  document.querySelector("#summary").innerHTML = [
    summaryCard("ユニーク", data.summary.uniqueStudents),
    summaryCard("入室", data.summary.enterCount),
    summaryCard("退室", data.summary.leaveCount),
    summaryCard("いま在室", data.summary.presentNow),
  ].join("");
  const max = Math.max(1, ...data.daily.map((row) => row.enters));
  document.querySelector("#chart").innerHTML = data.daily
    .map((row) => '<div class="bar" title="' + row.date + " enter " + row.enters + '" style="height:' + Math.round((row.enters / max) * 100) + '%"></div>')
    .join("");
  document.querySelector("#member-stats").innerHTML = data.members
    .map((row) => "<tr><td>" + row.studentId + "</td><td>" + row.displayName + "</td><td>" + row.enters + "</td><td>" + row.leaves + "</td><td>" + row.lastVisitAt + "</td></tr>")
    .join("");
}

async function loadMembers() {
  const data = await api("/api/members");
  document.querySelector("#members").innerHTML = data.members
    .map((row) => "<tr><td>" + row.studentId + "</td><td>" + (row.displayName || "") + "</td><td>" + (row.note || "") + "</td><td>" + (row.hasEnterSound ? "カスタム" : "デフォルト") + "</td><td>" + (row.hasLeaveSound ? "カスタム" : "デフォルト") + "</td></tr>")
    .join("");
}

async function loadDefaults() {
  const data = await api("/api/settings");
  document.querySelector("#default-status").textContent =
    "入室: " + (data.defaults.enter.hasSound ? "設定済み" : "未設定") +
    " / 退室: " + (data.defaults.leave.hasSound ? "設定済み" : "未設定");
}

async function loadKeys() {
  const data = await api("/api/api-keys");
  document.querySelector("#api-keys").innerHTML = data.apiKeys
    .map((row) => {
      const status = row.revoked_at ? "無効" : '<button data-revoke="' + row.id + '">失効</button>';
      return "<tr><td>" + row.name + "</td><td>" + row.key_prefix + "</td><td>" + (row.last_used_at || "-") + "</td><td>" + status + "</td></tr>";
    })
    .join("");
}

document.querySelector("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const studentId = form.studentId.value.trim().toUpperCase();
  await api("/api/members/" + encodeURIComponent(studentId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: form.displayName.value, note: form.note.value }),
  });
  await uploadSound("/api/sounds/enter/" + encodeURIComponent(studentId), form.enterSound.files[0]);
  await uploadSound("/api/sounds/leave/" + encodeURIComponent(studentId), form.leaveSound.files[0]);
  form.reset();
  await loadMembers();
  await loadDashboard();
});

document.querySelector("#default-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await uploadSound("/api/sounds/default/enter", form.enterSound.files[0]);
  await uploadSound("/api/sounds/default/leave", form.leaveSound.files[0]);
  form.reset();
  await loadDefaults();
});

document.querySelector("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = await api("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: form.name.value }),
  });
  document.querySelector("#new-key").textContent = "発行したキー: " + data.apiKey.token + "  （再表示できません）";
  await loadKeys();
});

document.querySelector("#api-keys").addEventListener("click", async (event) => {
  const id = event.target.getAttribute("data-revoke");
  if (!id) return;
  await api("/api/api-keys/" + id + "/revoke", { method: "POST" });
  await loadKeys();
});

monthInput.addEventListener("change", loadDashboard);

Promise.all([loadDashboard(), loadMembers(), loadDefaults(), loadKeys()]).catch((error) => {
  document.querySelector("#new-key").textContent = error.message;
});
