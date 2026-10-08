const chinese = navigator.language.startsWith("zh");
document.documentElement.lang = chinese ? "zh-CN" : "en";
for (const element of document.querySelectorAll("[data-en]")) {
  element.textContent = element.dataset[chinese ? "zh" : "en"];
}
const form = document.querySelector("form");
const url = document.querySelector("#url");
const error = document.querySelector("#error");
const button = document.querySelector("button");
const remote = document.querySelector('[value="remote"]');
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
form.addEventListener("change", () => {
  url.disabled = !remote.checked;
  url.required = remote.checked;
  if (remote.checked) url.focus();
});
invoke("get_backend_url").then((value) => {
  url.value = value;
  remote.checked = Boolean(value);
  document.querySelector('[value="local"]').checked = !value;
  url.disabled = !value;
  url.required = Boolean(value);
  button.disabled = false;
}).catch((reason) => {
  error.textContent = String(reason);
  // A damaged saved setting must not prevent choosing a new backend.
  button.disabled = false;
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  error.textContent = "";
  try {
    await invoke("set_backend_url", { url: remote.checked ? url.value.trim() : "" });
  } catch (reason) {
    error.textContent = String(reason);
    button.disabled = false;
  }
});
