import { client, unwrap, rpc } from "./api.js";
import { uuid } from "./id.js";
import { el } from "./ui.js";
export function prepareFiles(files) {
  if (files.length > 8) throw Error("Можно прикрепить не больше восьми файлов");
  return Array.from(files, (file) => ({ id: uuid(), file, uploaded: false }));
}
export async function uploadFile(item, conversation = null) {
  const { file } = item;
  const record = await rpc("reserve_upload", {
    p_id: item.id,
    p_conversation: conversation,
    p_filename: file.name,
    p_mime: file.type.split(";")[0],
    p_size: file.size,
  });
  if (!item.uploaded) {
    const { error } = await client.storage
      .from(record.bucket)
      .upload(record.path, file, { contentType: record.mime, upsert: false });
    if (error) {
      // A previous request may have committed before its response was lost.
      // Existing paths cannot be overwritten; only the same reservation is reused.
      const probe = await client.storage
        .from(record.bucket)
        .createSignedUrl(record.path, 60);
      if (probe.error) throw error;
    }
    item.uploaded = true;
  }
  return record;
}
export function attachmentView(file) {
  const container = el("div", { class: "attachment" });
  const button = el(
    "button",
    { class: "quiet", type: "button" },
    `${file.filename} · ${(file.byte_size / 1024).toFixed(0)} КБ`,
  );
  button.onclick = async () => {
    button.disabled = true;
    try {
      const { signedUrl } = await unwrap(
        client.storage.from(file.bucket).createSignedUrl(file.path, 60, {
          download:
            !file.mime.startsWith("image/") &&
            !file.mime.startsWith("video/") &&
            !file.mime.startsWith("audio/")
              ? file.filename
              : undefined,
        }),
      );
      let media;
      if (file.mime.startsWith("image/"))
        media = el("img", {
          src: signedUrl,
          alt: file.filename,
          loading: "lazy",
        });
      else if (file.mime.startsWith("video/"))
        media = el("video", {
          src: signedUrl,
          controls: "",
          playsinline: "",
          class: /^video-[0-9]+\.(webm|mp4)$/.test(file.filename)
            ? "round-recording"
            : "",
          preload: "metadata",
        });
      else if (file.mime.startsWith("audio/"))
        media = el("audio", {
          src: signedUrl,
          controls: "",
          preload: "metadata",
        });
      else
        media = el(
          "a",
          {
            href: signedUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "button quiet",
          },
          "Скачать файл",
        );
      container.replaceChildren(
        media,
        el("small", { class: "muted" }, "Ссылка действует одну минуту"),
        button,
      );
      button.textContent = "Обновить ссылку";
    } catch (error) {
      button.textContent = "Не удалось открыть. Повторить";
    } finally {
      button.disabled = false;
    }
  };
  container.append(button);
  return container;
}
