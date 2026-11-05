import { recordingPanel } from "./recorder.js";
import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, toast, busy, modal, empty } from "./ui.js";
import { uuid } from "./id.js";
import { prepareFiles, uploadFile, attachmentView } from "./uploads.js";
const act = (label, fn) =>
  el(
    "button",
    {
      class: "quiet",
      type: "button",
      onClick: async (e) => {
        try {
          await busy(e.currentTarget, fn);
        } catch (error) {
          toast(friendly(error));
        }
      },
    },
    label,
  );
export async function messenger(app, session, initialConversation = null) {
  let recorders = [];
  let disposed = false,
    roomVersion = 0,
    channel = null,
    records = new Map(),
    current = null,
    cursor = null,
    files = [],
    reply = null,
    pending = null,
    readTimer = null,
    syncTimer = null;
  let input,
    send,
    messages,
    form,
    attachments,
    context,
    older,
    search,
    date,
    connection;
  const list = el("aside", { class: "chat-list", "aria-label": "Переписки" }),
    room = card();
  room.classList.add("chat-room");
  const layout = el("div", { class: "chat-layout" }, list, room);
  app.append(layout);
  document.body.classList.add("in-chat");
  const resize = () =>
    document.documentElement.style.setProperty(
      "--viewport-height",
      (window.visualViewport?.height ?? innerHeight) + "px",
    );
  resize();
  window.visualViewport?.addEventListener("resize", resize);
  const cleanup = () => {
    disposed = true;
    recorders.forEach((r) => r.dispose());
    roomVersion++;
    clearTimeout(readTimer);
    clearTimeout(syncTimer);
    if (channel) client.removeChannel(channel);
    document.body.classList.remove("in-chat");
    window.visualViewport?.removeEventListener("resize", resize);
    window.removeEventListener("online", reconnect);
  };
  const reconnect = () => {
    if (current) refresh().catch((error) => toast(friendly(error)));
  };
  window.addEventListener("online", reconnect);
  async function showList() {
    const rows = await rpc("conversation_list");
    if (disposed) return;
    const add = act("Новая переписка", () => {
      const f = el("form", {}, el("h2", {}, "Найти жителя")),
        name = el("input", {
          "aria-label": "Никнейм",
          placeholder: "Точный никнейм",
          required: "",
        }),
        go = el("button", { type: "submit" }, "Открыть переписку");
      f.append(name, go);
      modal(f);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await busy(go, async () => {
            const users = await unwrap(
              client
                .from("profiles")
                .select("id,username,display_name")
                .ilike("username", name.value.trim())
                .limit(10),
            );
            const user = users.find(
              (u) =>
                u.username.toLowerCase() === name.value.trim().toLowerCase(),
            );
            if (!user) throw Error("Житель не найден");
            const id = await rpc("open_direct", { p_user: user.id });
            document.querySelector("#modal").close();
            await open({ id, title: user.display_name });
            await showList();
          });
        } catch (error) {
          toast(friendly(error));
        }
      };
    });
    list.replaceChildren(add);
    for (const c of rows) {
      const b = act("", () => open(c));
      b.classList.toggle("selected", current?.id === c.id);
      b.append(
        el("strong", {}, c.title),
        el("small", {}, c.last_body || "Пока без сообщений"),
        el(
          "span",
          { class: "small muted" },
          c.unread ? `${c.unread} новых` : "Открыть",
        ),
      );
      list.append(b);
    }
    if (!current && rows.length) await open(rows[0]);
  }
  function saveDraft() {
    if (current && input)
      sessionStorage.setItem(
        "kapani-draft-" + session.user.id + "-" + current.id,
        input.value,
      );
  }
  function draftKey() {
    return "kapani-draft-" + session.user.id + "-" + current.id;
  }
  function updateComposer() {
    attachments.replaceChildren(
      ...files.map((f, i) =>
        el(
          "span",
          { class: "tag" },
          f.file.name,
          act("Убрать", () => {
            files.splice(i, 1);
            pending = null;
            updateComposer();
          }),
        ),
      ),
    );
    context.replaceChildren(
      ...(reply
        ? [
            el("span", {}, "Ответ на " + reply.body.slice(0, 80)),
            act("Отменить ответ", () => {
              reply = null;
              pending = null;
              updateComposer();
            }),
          ]
        : []),
    );
  }
  async function fetchDetails(data, version) {
    if (!data.length || disposed || version !== roomVersion) return;
    const ids = data.map((m) => m.id);
    const [uploads, reactions, authors, members] = await Promise.all([
      unwrap(client.from("uploads").select("*").in("message_id", ids)),
      unwrap(
        client.from("message_reactions").select("*").in("message_id", ids),
      ),
      unwrap(
        client
          .from("profiles")
          .select("id,display_name")
          .in("id", [...new Set(data.map((m) => m.author_id))]),
      ),
      unwrap(
        client
          .from("conversation_members")
          .select("user_id,read_at")
          .eq("conversation_id", current.id),
      ),
    ]);
    if (disposed || version !== roomVersion) return;
    for (const m of data)
      records.set(m.id, {
        ...m,
        files: uploads.filter((f) => f.message_id === m.id),
        reactions: reactions.filter((r) => r.message_id === m.id),
        author:
          authors.find((a) => a.id === m.author_id)?.display_name ?? "Житель",
        read: members.some(
          (x) =>
            x.user_id !== session.user.id &&
            x.read_at &&
            x.read_at >= m.created_at,
        ),
      });
  }
  function draw(preserve = false) {
    const height = messages.scrollHeight,
      top = messages.scrollTop,
      nearBottom = height - top - messages.clientHeight < 100;
    const sorted = [...records.values()].sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
    messages.replaceChildren(...sorted.map(messageNode));
    if (!sorted.length) messages.append(empty("Сообщений пока нет"));
    if (preserve) messages.scrollTop = top + (messages.scrollHeight - height);
    else if (nearBottom || top === 0)
      messages.scrollTop = messages.scrollHeight;
    clearTimeout(readTimer);
    if (sorted.length && !search.value && !date.value)
      readTimer = setTimeout(() => {
        if (!disposed && document.visibilityState === "visible")
          rpc("mark_conversation_read", {
            p_conversation: current.id,
            p_message: sorted.at(-1).id,
          }).catch(() => {});
      }, 500);
  }
  function messageNode(m) {
    const mine = m.author_id === session.user.id,
      node = el("article", {
        class: "message" + (mine ? " mine" : ""),
        "data-message-id": m.id,
      });
    node.append(el("strong", { class: "small" }, m.author));
    if (m.reply_to)
      node.append(
        el(
          "div",
          { class: "reply-preview" },
          records.get(m.reply_to)?.body.slice(0, 100) ??
            "Ответ на более раннее сообщение",
        ),
      );
    node.append(
      el(
        "div",
        { class: "post-body" },
        m.deleted_at ? "Сообщение удалено" : m.body,
      ),
    );
    if (!m.deleted_at) node.append(...m.files.map(attachmentView));
    node.append(
      el(
        "small",
        { class: "muted" },
        new Date(m.created_at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }) +
          (m.edited_at ? " · изменено" : "") +
          (mine ? (m.read ? " · прочитано" : " · на сервере") : ""),
      ),
    );
    if (!m.deleted_at) {
      const menu = el(
        "details",
        { class: "message-menu" },
        el("summary", {}, "Действия"),
      );
      menu.append(
        act("Ответить", () => {
          reply = m;
          pending = null;
          updateComposer();
          input.focus();
        }),
        act("Копировать", async () => {
          if (!navigator.clipboard)
            throw Error("Копирование доступно при защищённом соединении");
          await navigator.clipboard.writeText(m.body);
          toast("Текст скопирован");
        }),
      );
      if (mine)
        menu.append(
          act("Изменить", () => {
            const f = el("form", {}, el("h2", {}, "Изменить сообщение")),
              text = el("textarea", {
                "aria-label": "Текст сообщения",
                maxlength: "12000",
              }),
              save = el("button", { type: "submit" }, "Сохранить");
            text.value = m.body;
            f.append(text, save);
            modal(f);
            f.onsubmit = async (e) => {
              e.preventDefault();
              try {
                await busy(save, async () => {
                  await rpc("edit_message", { p_id: m.id, p_body: text.value });
                  document.querySelector("#modal").close();
                  await refresh();
                });
              } catch (error) {
                toast(friendly(error));
              }
            };
          }),
          act("Удалить", async () => {
            if (!confirm("Удалить это сообщение для участников переписки?"))
              return;
            await rpc("edit_message", {
              p_id: m.id,
              p_body: "",
              p_delete: true,
            });
            await refresh();
          }),
        );
      const reactions = el("div", { class: "message-actions" });
      for (const [code, title] of Object.entries({
        like: "Нравится",
        thanks: "Спасибо",
        support: "Поддерживаю",
      })) {
        const count = m.reactions.filter((r) => r.reaction === code).length,
          mineReaction = m.reactions.find((r) => r.user_id === session.user.id);
        reactions.append(
          act(title + (count ? " " + count : ""), async () => {
            if (mineReaction?.reaction === code)
              await unwrap(
                client
                  .from("message_reactions")
                  .delete()
                  .eq("message_id", m.id)
                  .eq("user_id", session.user.id),
              );
            else
              await unwrap(
                client.from("message_reactions").upsert({
                  message_id: m.id,
                  user_id: session.user.id,
                  reaction: code,
                }),
              );
            await refresh();
          }),
        );
      }
      menu.append(reactions);
      node.append(menu);
    }
    return node;
  }
  async function refresh() {
    if (!current || disposed) return;
    const version = roomVersion;
    const data = await rpc("message_history", {
      p_conversation: current.id,
      p_search: search.value,
      p_date: date.value || null,
    });
    if (disposed || version !== roomVersion) return;
    await fetchDetails(data, version);
    if (disposed || version !== roomVersion) return;
    draw();
    await showList();
    if (disposed || version !== roomVersion) return;
    connection.textContent = "Соединение установлено";
  }
  async function open(c) {
    saveDraft();
    roomVersion++;
    const version = roomVersion;
    clearTimeout(readTimer);
    clearTimeout(syncTimer);
    const previousChannel = channel;
    channel = null;
    if (previousChannel) await client.removeChannel(previousChannel);
    if (disposed || version !== roomVersion) return;
    recorders.forEach((r) => r.dispose());
    recorders = [];
    current = c;
    records = new Map();
    files = [];
    pending = null;
    reply = null;
    cursor = null;
    connection = el("span", { class: "small muted" }, "Подключаем переписку…");
    messages = el("div", {
      class: "messages",
      role: "log",
      "aria-label": "Сообщения",
    });
    form = el("form", { class: "composer" });
    input = el("textarea", {
      "aria-label": "Сообщение",
      maxlength: "12000",
      placeholder: "Написать сообщение…",
    });
    input.value = sessionStorage.getItem(draftKey()) ?? "";
    input.oninput = saveDraft;
    send = el("button", { type: "submit" }, "Отправить");
    form.append(input, send);
    attachments = el("div", { class: "attachment-list" });
    context = el("div", { class: "reply-context" });
    const file = el("input", {
      type: "file",
      multiple: "",
      "aria-label": "Прикрепить файлы",
      accept: ".jpg,.jpeg,.png,.webp,.mp4,.webm,.ogg,.mp3,.pdf,.txt",
    });
    file.onchange = () => {
      try {
        files = prepareFiles([...files.map((f) => f.file), ...file.files]);
        pending = null;
        updateComposer();
        file.value = "";
      } catch (e) {
        toast(e.message);
      }
    };
    search = el("input", {
      type: "search",
      "aria-label": "Поиск в переписке",
      placeholder: "Найти сообщение",
    });
    date = el("input", {
      type: "date",
      "aria-label": "Дата по московскому времени",
    });
    const filter = act("Найти", async () => {
        records.clear();
        cursor = null;
        await loadOlder();
      }),
      reset = act("Сбросить", async () => {
        search.value = "";
        date.value = "";
        records.clear();
        cursor = null;
        await loadOlder();
      });
    older = act("Более ранние сообщения", loadOlder);
    const recordingDetails = el(
      "details",
      {},
      el("summary", {}, "Записать голос или короткое видео"),
    );
    recorders = ["audio", "video"].map((kind) =>
      recordingPanel((recorded) => {
        if (disposed || version !== roomVersion)
          throw Error("Эта переписка уже закрыта");
        if (send.disabled) throw Error("Дождись завершения отправки");
        const prepared = prepareFiles([recorded]);
        if (files.length >= 8)
          throw Error("Можно прикрепить не больше восьми файлов");
        files.push(...prepared);
        pending = null;
        updateComposer();
      }, kind),
    );
    recordingDetails.append(...recorders.map((r) => r.element));
    room.replaceChildren(
      el(
        "div",
        { class: "row" },
        el("h2", {}, c.title ?? "Переписка"),
        act("Закрепить / открепить", async () => {
          await unwrap(
            client
              .from("conversation_members")
              .update({ pinned: !c.pinned })
              .eq("conversation_id", c.id)
              .eq("user_id", session.user.id),
          );
          c.pinned = !c.pinned;
          await showList();
        }),
      ),
      connection,
      el(
        "details",
        {},
        el("summary", {}, "Поиск и дата"),
        search,
        date,
        filter,
        reset,
      ),
      older,
      messages,
      context,
      attachments,
      el("details", {}, el("summary", {}, "Вложения до 20 МБ"), file),
      recordingDetails,
      form,
    );
    const composerInput = input;
    const composerSend = send;
    const composerDraftKey = draftKey();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (disposed || version !== roomVersion || composerSend.disabled) return;
      if (!composerInput.value.trim() && !files.length) return;
      const body = composerInput.value;
      const sendingFiles = [...files];
      const replyId = reply?.id ?? null;
      try {
        await busy(composerSend, async () => {
          const fingerprint = JSON.stringify([
            body,
            sendingFiles.map((f) => f.id),
            replyId,
          ]);
          if (pending?.fingerprint !== fingerprint)
            pending = { id: uuid(), fingerprint };
          const messageId = pending.id;
          composerInput.disabled = true;
          file.disabled = true;
          const uploaded = [];
          for (const f of sendingFiles)
            uploaded.push(await uploadFile(f, c.id));
          await rpc("send_message_media", {
            p_id: messageId,
            p_conversation: c.id,
            p_body: body,
            p_uploads: uploaded.map((f) => f.id),
            p_reply: replyId,
          });
          if (sessionStorage.getItem(composerDraftKey) === body)
            sessionStorage.removeItem(composerDraftKey);
          if (disposed || version !== roomVersion) return;
          input.value = "";
          sessionStorage.removeItem(draftKey());
          files = [];
          reply = null;
          pending = null;
          updateComposer();
          await refresh();
          messages.scrollTop = messages.scrollHeight;
        });
      } catch (error) {
        toast(
          friendly(error) +
            " Текст и вложения сохранены для повторной отправки.",
        );
      } finally {
        composerInput.disabled = false;
        file.disabled = false;
      }
    };
    channel = client
      .channel("messages-" + c.id + "-" + uuid())
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: "conversation_id=eq." + c.id,
        },
        () => {
          clearTimeout(syncTimer);
          syncTimer = setTimeout(() => {
            if (version === roomVersion)
              refresh().catch((e) => toast(friendly(e)));
          }, 120);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversation_members",
          filter: "conversation_id=eq." + c.id,
        },
        () => {
          if (version === roomVersion) refresh().catch(() => {});
        },
      )
      .subscribe((status) => {
        if (version !== roomVersion || disposed) return;
        connection.textContent =
          status === "SUBSCRIBED"
            ? "В сети"
            : status === "CHANNEL_ERROR"
              ? "Связь прервалась. Переподключаемся…"
              : "Подключаемся…";
        if (status === "SUBSCRIBED") refresh().catch((e) => toast(friendly(e)));
      });
    await loadOlder();
  }
  async function loadOlder() {
    const version = roomVersion,
      data = await rpc("message_history", {
        p_conversation: current.id,
        p_before: cursor?.created_at ?? null,
        p_before_id: cursor?.id ?? null,
        p_search: search.value,
        p_date: date.value || null,
      });
    if (disposed || version !== roomVersion) return;
    const preserve = !!cursor;
    cursor = data.at(-1) ?? cursor;
    await fetchDetails(data, version);
    if (version !== roomVersion) return;
    draw(preserve);
    older.disabled = data.length < 60;
    older.dataset.exhausted = String(data.length < 60);
    older.textContent =
      data.length < 60 ? "Начало истории" : "Более ранние сообщения";
  }
  try {
    if (initialConversation) await open(initialConversation);
    await showList();
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
