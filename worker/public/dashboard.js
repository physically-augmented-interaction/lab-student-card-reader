const monthInput = document.querySelector("#month");
monthInput.value = currentMonthValue();

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

monthInput.addEventListener("change", () => {
  loadDashboard().catch((error) => {
    document.querySelector("#error").textContent = error.message;
  });
});

loadDashboard().catch((error) => {
  document.querySelector("#error").textContent = error.message;
});
