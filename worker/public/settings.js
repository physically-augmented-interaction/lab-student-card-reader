async function loadMembers() {
  const data = await api("/api/members");
  document.querySelector("#members").innerHTML = data.members
    .map((row) => "<tr><td>" + row.studentId + "</td><td>" + (row.displayName || "-") + "</td><td>" + (row.note || "-") + "</td><td>" + (row.hasEnterSound ? "カスタム" : "デフォルト") + "</td><td>" + (row.hasLeaveSound ? "カスタム" : "デフォルト") + "</td></tr>")
    .join("");
  if (!data.members.length) {
    document.querySelector("#members").innerHTML = '<tr><td class="empty" colspan="5">まだメンバーがいません</td></tr>';
  }
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
      const qr = row.qrUrl ? '<div class="qr-box"><img alt="API QR" src="' + escapeHtml(row.qrUrl) + '" /></div>' : "";
      return "<tr><td>" + escapeHtml(row.name) + "</td><td>" + escapeHtml(row.key_prefix) + "</td><td>" + escapeHtml(row.lastUsedAtLabel || row.last_used_at || "-") + "</td><td>" + status + qr + "</td></tr>";
    })
    .join("");
  if (!data.apiKeys.length) {
    document.querySelector("#api-keys").innerHTML = '<tr><td class="empty" colspan="4">まだ API キーがありません</td></tr>';
  }
}

document.querySelector("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const notice = document.querySelector("#member-notice");
  try {
    const studentId = form.studentId.value.trim().toUpperCase();
    await api("/api/members/" + encodeURIComponent(studentId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: form.displayName.value, note: form.note.value }),
    });
    await uploadSound("/api/sounds/enter/" + encodeURIComponent(studentId), form.enterSound.files[0]);
    await uploadSound("/api/sounds/leave/" + encodeURIComponent(studentId), form.leaveSound.files[0]);
    form.reset();
    notice.textContent = studentId + " を保存しました";
    await loadMembers();
  } catch (error) {
    notice.textContent = error.message;
  }
});

document.querySelector("#default-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const notice = document.querySelector("#default-status");
  try {
    await uploadSound("/api/sounds/default/enter", form.enterSound.files[0]);
    await uploadSound("/api/sounds/default/leave", form.leaveSound.files[0]);
    form.reset();
    await loadDefaults();
  } catch (error) {
    notice.textContent = error.message;
  }
});

document.querySelector("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = await api("/api/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: form.name.value }),
    });
    document.querySelector("#new-key").textContent = "発行したキー: " + data.apiKey.token + "  （再表示できません）";
    const qrBox = document.querySelector("#new-key-qr");
    const payload = JSON.stringify({
      v: 1,
      apiBaseUrl: location.origin,
      apiKey: data.apiKey.token,
      deviceId: form.name.value || "tablet-1",
    });
    qrBox.innerHTML = '<img alt="API QR" src="/api/api-keys/' + encodeURIComponent(data.apiKey.id) + '/qr?token=' + encodeURIComponent(data.apiKey.token) + '" /><pre>' + escapeHtml(payload) + "</pre>";
    await loadKeys();
  } catch (error) {
    document.querySelector("#new-key").textContent = error.message;
  }
});

document.querySelector("#api-keys").addEventListener("click", async (event) => {
  const id = event.target.getAttribute("data-revoke");
  if (!id) return;
  await api("/api/api-keys/" + id + "/revoke", { method: "POST" });
  await loadKeys();
});

Promise.all([loadMembers(), loadDefaults(), loadKeys()]).catch((error) => {
  document.querySelector("#new-key").textContent = error.message;
});
