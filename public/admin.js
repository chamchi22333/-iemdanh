const totalCount = document.querySelector("#totalCount");
const recordsBody = document.querySelector("#recordsBody");
const clearData = document.querySelector("#clearData");
const meetingForm = document.querySelector("#meetingForm");
const meetingName = document.querySelector("#meetingName");
const setupView = document.querySelector("#setupView");
const recordsView = document.querySelector("#recordsView");
const recordsTitle = document.querySelector("#recordsTitle");
const exportLink = document.querySelector("#exportLink");
const openQrButton = document.querySelector("#openQrButton");

let currentMeetingName = localStorage.getItem("meetingName") || "";

if (currentMeetingName) {
  meetingName.value = currentMeetingName;
}

async function refreshState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const state = await response.json();

  totalCount.textContent = `${state.submissions.length} lượt điểm danh`;
  renderRows(state.submissions);
}

function renderRows(rows) {
  if (!rows.length) {
    recordsBody.innerHTML = `<tr><td colspan="4" class="empty-cell">Chưa có dữ liệu điểm danh</td></tr>`;
    return;
  }

  recordsBody.innerHTML = rows
    .slice()
    .reverse()
    .map((row) => `
      <tr>
        <td>${escapeHtml(row.fullName)}</td>
        <td>${escapeHtml(row.unit)}</td>
        <td>${escapeHtml(row.studentId)}</td>
        <td>${escapeHtml(row.confirmed)}</td>
      </tr>
    `)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

clearData.addEventListener("click", async () => {
  if (!confirm("Xóa toàn bộ dữ liệu điểm danh hiện tại?")) return;
  await fetch("/api/clear", { method: "POST" });
  await refreshState();
});

meetingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = meetingName.value.trim();
  if (!name) return;

  currentMeetingName = name;
  localStorage.setItem("meetingName", name);
  showRecordsView(name);
});

openQrButton.addEventListener("click", () => {
  if (!currentMeetingName) return;
  openQrTab(currentMeetingName);
});

function showRecordsView(name) {
  recordsTitle.textContent = name;
  exportLink.href = `/export.xlsx?meeting=${encodeURIComponent(name)}`;
  setupView.hidden = true;
  recordsView.hidden = false;
}

function openQrTab(name) {
  const url = `/display?meeting=${encodeURIComponent(name)}`;
  window.open(url, "_blank", "noopener");
}

refreshState();
setInterval(refreshState, 1000);
