const form = document.querySelector("#checkinForm");
const message = document.querySelector("#message");
const fullName = document.querySelector("#fullName");
const studentId = document.querySelector("#studentId");

fullName.addEventListener("blur", () => {
  fullName.value = titleCaseVietnamese(fullName.value);
});

studentId.addEventListener("input", () => {
  studentId.value = studentId.value.toUpperCase().replace(/\s/g, "");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  message.className = "message";

  const payload = {
    sessionId: document.querySelector("#sessionId").value,
    fullName: titleCaseVietnamese(fullName.value),
    unit: document.querySelector("#unit").value.trim(),
    studentId: studentId.value.trim().toUpperCase(),
    confirmed: document.querySelector("#confirmed").checked
  };

  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Đang gửi...";

  try {
    const response = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    message.textContent = result.message;
    message.classList.add(result.ok ? "success" : "error");

    if (result.ok) {
      form.reset();
      form.querySelectorAll("input, button").forEach((element) => {
        element.disabled = true;
      });
    } else {
      button.disabled = false;
      button.textContent = "Gửi điểm danh";
    }
  } catch {
    message.textContent = "Không gửi được dữ liệu. Vui lòng thử lại.";
    message.classList.add("error");
    button.disabled = false;
    button.textContent = "Gửi điểm danh";
  }
});

function titleCaseVietnamese(value) {
  return value
    .toLocaleLowerCase("vi-VN")
    .replace(/(^|\s|-)(\p{L})/gu, (match, prefix, char) => prefix + char.toLocaleUpperCase("vi-VN"))
    .replace(/\s+/g, " ")
    .trim();
}
