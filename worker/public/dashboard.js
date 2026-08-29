const monthInput = document.querySelector("#month");
const errorEl = document.querySelector("#error");
const summaryEl = document.querySelector("#summary");
const chartEl = document.querySelector("#chart");
const filtersEl = document.querySelector("#filters");
const tableEl = document.querySelector("#member-stats");

monthInput.value = currentMonthValue();

let dashboard = null;
let selectedDate = null;
let selectedStudentId = null;

function summaryCard(label, value) {
  return '<div class="card"><span>' + label + '</span><b>' + value + '</b></div>';
}

function formatDayLabel(date) {
  const [year, month, day] = date.split("-");
  return Number(month) + "/" + Number(day);
}

function selectedMember() {
  if (!dashboard || !selectedStudentId) return null;
  return dashboard.members.find((row) => row.studentId === selectedStudentId) || null;
}

function filteredMembers() {
  if (!dashboard) return [];
  if (selectedDate) {
    const day = dashboard.daily.find((row) => row.date === selectedDate);
    const members = day ? day.members : [];
    if (selectedStudentId) return members.filter((row) => row.studentId === selectedStudentId);
    return members;
  }
  if (selectedStudentId) return dashboard.members.filter((row) => row.studentId === selectedStudentId);
  return dashboard.members;
}

function renderSummary() {
  if (!dashboard) return;
  summaryEl.innerHTML = [
    summaryCard("今日の入室人数", dashboard.summary.todayEnterUnique),
    summaryCard("いま在室", dashboard.summary.presentNow),
  ].join("");
}

function renderChart() {
  if (!dashboard) return;
  const member = selectedMember();
  const counts = dashboard.daily.map((row) => {
    if (member) return member.days && member.days.indexOf(row.date) >= 0 ? 1 : 0;
    return row.uniqueStudents;
  });
  const max = Math.max(1, ...counts);
  chartEl.innerHTML = dashboard.daily
    .map((row) => {
      const count = member ? (member.days && member.days.indexOf(row.date) >= 0 ? 1 : 0) : row.uniqueStudents;
      const selected = row.date === selectedDate ? " selected" : "";
      const height = Math.max(count ? 8 : 2, Math.round((count / max) * 100));
      return '<button type="button" class="bar' + selected + '" data-date="' + row.date + '" title="' +
        escapeHtml(formatDayLabel(row.date) + ' ' + count + '人') +
        '" style="height:' + height + '%"></button>';
    })
    .join("");
}

function renderFilters() {
  const chips = [];
  if (selectedDate) {
    chips.push('<span class="chip">日付 ' + escapeHtml(formatDayLabel(selectedDate)) +
      ' <button type="button" data-clear="date" aria-label="日付フィルターを解除">×</button></span>');
  }
  const member = selectedMember();
  if (member) {
    chips.push('<span class="chip">メンバー ' + escapeHtml(member.displayName || member.studentId) +
      ' <button type="button" data-clear="member" aria-label="メンバーフィルターを解除">×</button></span>');
  }
  if (!chips.length) {
    filtersEl.hidden = true;
    filtersEl.innerHTML = "";
    return;
  }
  filtersEl.hidden = false;
  filtersEl.innerHTML = '<span class="filter-label">絞り込み</span>' + chips.join("") +
    '<button type="button" class="ghost compact" data-clear="all">解除</button>';
}

function renderTable() {
  const members = filteredMembers();
  if (!members.length) {
    tableEl.innerHTML = '<tr><td class="empty" colspan="4">この条件の来室データはありません</td></tr>';
    return;
  }
  tableEl.innerHTML = members
    .map((row) => {
      const selected = row.studentId === selectedStudentId ? ' class="selected"' : "";
      const days = selectedDate ? 1 : (row.uniqueDays || (row.days ? row.days.length : 0));
      return '<tr' + selected + '>' +
        '<td><button type="button" class="link" data-student="' + escapeHtml(row.studentId) + '">' + escapeHtml(row.studentId) + '</button></td>' +
        '<td><button type="button" class="link" data-student="' + escapeHtml(row.studentId) + '">' + escapeHtml(row.displayName || row.studentId) + '</button></td>' +
        '<td>' + days + '</td>' +
        '<td>' + escapeHtml(row.lastVisitAtLabel || row.lastVisitAt || "-") + '</td>' +
        '</tr>';
    })
    .join("");
}

function renderDashboard() {
  renderSummary();
  renderChart();
  renderFilters();
  renderTable();
}

async function loadDashboard() {
  dashboard = await api("/api/dashboard?month=" + encodeURIComponent(monthInput.value));
  if (selectedDate && !dashboard.daily.some((row) => row.date === selectedDate)) selectedDate = null;
  if (selectedStudentId && !dashboard.members.some((row) => row.studentId === selectedStudentId)) selectedStudentId = null;
  renderDashboard();
}

function setError(error) {
  errorEl.textContent = error instanceof Error ? error.message : String(error);
}

chartEl.addEventListener("click", (event) => {
  const dateButton = event.target.closest("[data-date]");
  const date = dateButton ? dateButton.getAttribute("data-date") : null;
  if (!date) return;
  selectedDate = selectedDate === date ? null : date;
  renderDashboard();
});

tableEl.addEventListener("click", (event) => {
  const studentButton = event.target.closest("[data-student]");
  const studentId = studentButton ? studentButton.getAttribute("data-student") : null;
  if (!studentId) return;
  selectedStudentId = selectedStudentId === studentId ? null : studentId;
  renderDashboard();
});

filtersEl.addEventListener("click", (event) => {
  const clearButton = event.target.closest("[data-clear]");
  const clear = clearButton ? clearButton.getAttribute("data-clear") : null;
  if (!clear) return;
  if (clear === "date" || clear === "all") selectedDate = null;
  if (clear === "member" || clear === "all") selectedStudentId = null;
  renderDashboard();
});

monthInput.addEventListener("change", () => {
  selectedDate = null;
  selectedStudentId = null;
  loadDashboard().catch(setError);
});

loadDashboard().catch(setError);
