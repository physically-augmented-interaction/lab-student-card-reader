async function loadMembers() {
  const data = await api("/api/members");
  document.querySelector("#members").innerHTML = data.members
    .map((row) => {
      return "<tr>" +
        "<td>" + escapeHtml(row.studentId) + "</td>" +
        "<td>" + escapeHtml(row.displayName || "-") + "</td>" +
        "<td>" + escapeHtml(row.note || "-") + "</td>" +
        "<td>" + (row.hasEnterSound ? "カスタム" : "デフォルト") + "</td>" +
        "<td>" + (row.hasLeaveSound ? "カスタム" : "デフォルト") + "</td>" +
        '<td class="row-actions">' +
          '<button type="button" class="compact" data-edit="' + escapeHtml(row.studentId) + '">編集</button>' +
          '<button type="button" class="ghost compact" data-delete="' + escapeHtml(row.studentId) + '">削除</button>' +
        "</td></tr>";
    })
    .join("");
  if (!data.members.length) {
    document.querySelector("#members").innerHTML = '<tr><td class="empty" colspan="6">まだメンバーがいません</td></tr>';
  }
}

function resetMemberForm() {
  const form = document.querySelector("#member-form");
  form.reset();
  form.studentId.readOnly = false;
  document.querySelector("#member-heading").textContent = "メンバー追加";
  document.querySelector("#member-cancel").hidden = true;
}

function fillMemberForm(member) {
  const form = document.querySelector("#member-form");
  form.studentId.value = member.studentId;
  form.studentId.readOnly = true;
  form.displayName.value = member.displayName || "";
  form.note.value = member.note || "";
  form.enterSound.value = "";
  form.leaveSound.value = "";
  document.querySelector("#member-heading").textContent = member.studentId + " を編集";
  document.querySelector("#member-cancel").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
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
    resetMemberForm();
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

document.querySelector("#member-cancel").addEventListener("click", () => {
  resetMemberForm();
  document.querySelector("#member-notice").textContent = "";
});

document.querySelector("#members").addEventListener("click", async (event) => {
  const editId = event.target.getAttribute("data-edit");
  const deleteId = event.target.getAttribute("data-delete");
  const notice = document.querySelector("#member-notice");
  try {
    if (editId) {
      const data = await api("/api/members/" + encodeURIComponent(editId));
      fillMemberForm(data.member);
      notice.textContent = editId + " を編集中です。効果音は選び直したときだけ上書きします。";
      return;
    }
    if (deleteId) {
      if (!window.confirm(deleteId + " を削除しますか？入退室の履歴は残ります。")) return;
      await api("/api/members/" + encodeURIComponent(deleteId), { method: "DELETE" });
      if (document.querySelector("#member-form").studentId.value === deleteId) resetMemberForm();
      notice.textContent = deleteId + " を削除しました";
      await loadMembers();
    }
  } catch (error) {
    notice.textContent = error.message;
  }
});

Promise.all([loadMembers(), loadDefaults(), loadKeys()]).catch((error) => {
  document.querySelector("#new-key").textContent = error.message;
});
