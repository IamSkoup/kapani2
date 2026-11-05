import { uuid } from "./id.js";
export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child != null)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
};
export const card = (...children) =>
  el("section", { class: "card" }, ...children);
export function toast(text) {
  const n = document.querySelector("#status");
  n.textContent = text;
  n.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (n.style.display = "none"), 6000);
}
export async function busy(button, fn) {
  button.disabled = true;
  const original = [...button.childNodes];
  button.textContent = "Подождите…";
  try {
    return await fn();
  } finally {
    button.disabled = button.dataset.exhausted === "true";
    if (button.textContent === "Подождите…")
      button.replaceChildren(...original);
  }
}
export function field(form, label, name, type = "text", value = "") {
  const id = "f-" + uuid();
  form.append(el("label", { for: id }, label));
  const input = el(type === "textarea" ? "textarea" : "input", {
    id,
    name,
    ...(type === "textarea" ? {} : { type }),
    required: "",
    value,
  });
  if (type === "textarea") input.value = value;
  form.append(input);
  return input;
}
export const empty = (text) => el("div", { class: "empty" }, text);
export function modal(...children) {
  const d = document.querySelector("#modal");
  document.querySelector("#modal-body").replaceChildren(...children);
  d.showModal();
  return d;
}
