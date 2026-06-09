const displayMeetingName = document.querySelector("#displayMeetingName");
const displayQrImage = document.querySelector("#displayQrImage");
const displayCountdown = document.querySelector("#displayCountdown");
const qrError = document.querySelector("#qrError");

const params = new URLSearchParams(window.location.search);
const meetingName = params.get("meeting") || localStorage.getItem("meetingName") || "Hội thảo toàn trường";
let lastUrl = "";

displayMeetingName.textContent = meetingName;
document.title = `${meetingName} - Mã QR điểm danh`;

async function refreshDisplay() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("Cannot load QR state");
    const state = await response.json();

    displayCountdown.textContent = formatClock(state.remainingSeconds);
    displayCountdown.setAttribute("datetime", `PT${state.remainingSeconds}S`);

    if (state.checkinUrl !== lastUrl) {
      lastUrl = state.checkinUrl;
      qrError.hidden = true;
      displayQrImage.src = qrImageUrl(state.checkinUrl);
    }
  } catch {
    qrError.hidden = false;
  }
}

displayQrImage.addEventListener("error", () => {
  qrError.hidden = false;
});

displayQrImage.addEventListener("load", () => {
  qrError.hidden = true;
});

refreshDisplay();
setInterval(refreshDisplay, 1000);

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function qrImageUrl(value) {
  const data = encodeURIComponent(value);
  return `https://api.qrserver.com/v1/create-qr-code/?size=700x700&margin=24&data=${data}&v=${Date.now()}`;
}
