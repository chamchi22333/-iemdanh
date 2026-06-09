const displayMeetingName = document.querySelector("#displayMeetingName");
const displayQrImage = document.querySelector("#displayQrImage");
const displayCountdown = document.querySelector("#displayCountdown");

const params = new URLSearchParams(window.location.search);
const meetingName = params.get("meeting") || localStorage.getItem("meetingName") || "Hội thảo toàn trường";
let lastUrl = "";

displayMeetingName.textContent = meetingName;
document.title = `${meetingName} - Mã QR điểm danh`;

async function refreshDisplay() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const state = await response.json();

  displayCountdown.textContent = formatClock(state.remainingSeconds);
  displayCountdown.setAttribute("datetime", `PT${state.remainingSeconds}S`);

  if (state.checkinUrl !== lastUrl) {
    lastUrl = state.checkinUrl;
    displayQrImage.src = `/api/qr.svg?data=${encodeURIComponent(state.checkinUrl)}&v=${Date.now()}`;
  }
}

refreshDisplay();
setInterval(refreshDisplay, 1000);

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
