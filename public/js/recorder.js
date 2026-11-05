import { el } from "./ui.js";

// Recordings stay in memory until the resident explicitly attaches the preview.
export function recordingPanel(onAttach, kind = "audio") {
  const video = kind === "video";
  const root = el("section", { class: "recording-panel" }),
    status = el(
      "p",
      { "aria-live": "polite" },
      video ? "Короткое видео до 60 секунд" : "Голосовое сообщение до 2 минут",
    );
  const preview = el(video ? "video" : "audio", {
    controls: "",
    playsinline: "",
    preload: "metadata",
  });
  if (video) preview.className = "round-recording";
  const start = el(
      "button",
      { type: "button", class: "quiet" },
      "Начать запись",
    ),
    pause = el("button", { type: "button", class: "quiet" }, "Пауза"),
    stop = el(
      "button",
      { type: "button", class: "quiet" },
      "Прослушать / посмотреть",
    ),
    attach = el("button", { type: "button" }, "Прикрепить запись"),
    discard = el(
      "button",
      { type: "button", class: "quiet" },
      "Отменить запись",
    );
  root.append(
    status,
    preview,
    el("div", { class: "actions" }, start, pause, stop, attach, discard),
  );
  let recorder = null,
    stream = null,
    chunks = [],
    blob = null,
    url = null,
    timer = null,
    disposed = false,
    generation = 0,
    bytes = 0,
    failed = false,
    elapsed = 0,
    mime = "";
  const tracksOff = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  function reset() {
    generation++;
    clearInterval(timer);
    timer = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null;
    tracksOff();
    preview.srcObject = null;
    preview.removeAttribute("src");
    if (url) URL.revokeObjectURL(url);
    url = null;
    blob = null;
    chunks = [];
    start.disabled = false;
    pause.disabled = true;
    stop.disabled = true;
    attach.disabled = true;
    pause.textContent = "Пауза";
  }
  reset();
  start.onclick = async () => {
    reset();
    const version = generation;
    start.disabled = true;
    status.textContent = "Запрашиваем разрешение устройства…";
    try {
      if (
        !globalThis.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !globalThis.MediaRecorder
      )
        throw Error(
          "Запись доступна в совместимом браузере через HTTPS. Можно прикрепить готовый файл.",
        );
      const candidates = video
        ? ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
      mime = candidates.find((t) => MediaRecorder.isTypeSupported(t));
      if (!mime)
        throw Error(
          "Этот браузер не поддерживает доступный формат записи. Прикрепи готовый файл.",
        );
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video
          ? {
              width: { ideal: 480 },
              height: { ideal: 480 },
              facingMode: "user",
            }
          : false,
      });
      if (disposed || version !== generation) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      chunks = [];
      bytes = 0;
      failed = false;
      elapsed = 0;
      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        ...(video
          ? { videoBitsPerSecond: 700000 }
          : { audioBitsPerSecond: 64000 }),
      });
      if (video) {
        preview.srcObject = stream;
        preview.muted = true;
        preview.play().catch(() => {});
      }
      recorder.ondataavailable = (e) => {
        if (version !== generation || !e.data.size) return;
        bytes += e.data.size;
        if (bytes > 20 * 1024 * 1024) {
          failed = true;
          recorder.stop();
          return;
        }
        chunks.push(e.data);
      };
      recorder.onerror = () => {
        failed = true;
        status.textContent = "Устройство прервало запись. Попробуй ещё раз.";
        clearInterval(timer);
        tracksOff();
        start.disabled = false;
        pause.disabled = true;
        stop.disabled = true;
      };
      recorder.onstop = () => {
        if (disposed || version !== generation) return;
        clearInterval(timer);
        tracksOff();
        preview.srcObject = null;
        preview.muted = false;
        pause.disabled = true;
        stop.disabled = true;
        start.disabled = false;
        if (failed || !chunks.length) {
          status.textContent =
            "Запись не сохранена. Возможно, превышен размер 20 МБ.";
          return;
        }
        blob = new Blob(chunks, { type: mime.split(";")[0] });
        url = URL.createObjectURL(blob);
        preview.src = url;
        attach.disabled = false;
        status.textContent =
          "Проверь запись. Она ещё не загружена и не отправлена.";
      };
      recorder.start(500);
      pause.disabled = false;
      stop.disabled = false;
      status.textContent = "Идёт запись";
      timer = setInterval(() => {
        if (recorder?.state === "recording") {
          elapsed++;
          status.textContent = "Записано " + elapsed + " сек.";
          if (elapsed >= (video ? 60 : 120)) recorder.stop();
        }
      }, 1000);
    } catch (error) {
      if (disposed || version !== generation) return;
      reset();
      status.textContent =
        error.name === "NotAllowedError"
          ? "Нет разрешения на микрофон или камеру. Доступ можно изменить в настройках браузера."
          : error.message;
    }
  };
  pause.onclick = () => {
    if (recorder?.state === "recording") {
      recorder.pause();
      pause.textContent = "Продолжить";
      status.textContent = "Запись на паузе";
    } else if (recorder?.state === "paused") {
      recorder.resume();
      pause.textContent = "Пауза";
    }
  };
  stop.onclick = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };
  discard.onclick = () => {
    reset();
    status.textContent = "Запись отменена";
  };
  attach.onclick = () => {
    if (!blob) return;
    try {
      const ext = blob.type.endsWith("mp4")
        ? "mp4"
        : blob.type.endsWith("ogg")
          ? "ogg"
          : "webm";
      onAttach(
        new File(
          [blob],
          (video ? "video" : "voice") + "-" + Date.now() + "." + ext,
          { type: blob.type },
        ),
      );
      reset();
      status.textContent =
        "Запись прикреплена к черновику. Для отправки нажми «Отправить».";
    } catch (error) {
      status.textContent = error.message;
    }
  };
  return {
    element: root,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
