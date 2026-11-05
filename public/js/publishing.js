import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, empty, modal, busy, toast } from "./ui.js";
import { uuid } from "./id.js";
const action = (name, fn) =>
  el(
    "button",
    {
      type: "button",
      class: "quiet",
      onClick: async (e) => {
        try {
          await busy(e.currentTarget, fn);
        } catch (error) {
          toast(friendly(error));
        }
      },
    },
    name,
  );
const status = {
  draft: "Черновик",
  published: "Опубликовано",
  archived: "В архиве",
  open: "Регистрация открыта",
  closed: "Регистрация закрыта",
  completed: "Завершено",
  cancelled: "Отменено",
  registered: "Участвую",
  withdrawn: "Регистрация отменена",
  attended: "Участие подтверждено",
};
async function myRoles(session) {
  return unwrap(
    client.from("user_roles").select("role").eq("user_id", session.user.id),
  );
}
export async function newsPage(app, session) {
  const roles = await myRoles(session),
    mayor = roles.some((r) => r.role === "mayor"),
    editor = mayor || roles.some((r) => r.role === "journalist");
  app.append(
    el("h1", {}, "Новости Капани"),
    el("p", {}, "Жизнь посёлка и Капанёвских земель."),
  );
  if (editor) app.append(action("Написать новость", () => edit()));
  const filter = el(
    "select",
    { "aria-label": "Категория новостей" },
    el("option", { value: "" }, "Все новости"),
    el("option", { value: "village" }, "Посёлок"),
    el("option", { value: "lands" }, "Капанёвские земли"),
  );
  const list = el("div", { class: "section" }),
    more = action("Загрузить ещё", () => load());
  let offset = 0;
  app.append(filter, list, more);
  filter.onchange = () => {
    offset = 0;
    list.replaceChildren();
    load().catch((e) => toast(friendly(e)));
  };
  async function load() {
    let q = client
      .from("news")
      .select("*,profiles!author_id(display_name)")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + 19);
    if (filter.value) q = q.eq("category", filter.value);
    const rows = await unwrap(q);
    for (const n of rows) {
      const node = card(
        el(
          "div",
          { class: "row" },
          el("span", { class: "tag" }, status[n.status]),
          el(
            "small",
            { class: "muted" },
            n.category === "lands" ? "Капанёвские земли" : "Посёлок",
          ),
        ),
        el("h2", {}, n.title),
        el("p", { class: "post-body" }, n.body.slice(0, 280)),
        el(
          "small",
          {},
          n.profiles.display_name +
            " · " +
            new Date(n.published_at ?? n.created_at).toLocaleDateString(
              "ru-RU",
            ),
        ),
        action("Читать", async () => {
          const views =
            n.status === "published"
              ? await rpc("view_news", { p_id: n.id })
              : null;
          modal(
            el("h2", {}, n.title),
            el("p", { class: "post-body" }, n.body),
            el(
              "small",
              { class: "muted" },
              views === null ? "Черновик" : `${views} читателей`,
            ),
            el(
              "a",
              {
                href: "#chat?conversation=" + n.discussion_id,
                class: "button",
                onClick: () => document.querySelector("#modal").close(),
              },
              "Обсудить",
            ),
          );
        }),
      );
      if (editor && (mayor || n.author_id === session.user.id))
        node.append(
          action("Редактировать", () => edit(n)),
          action("В архив", async () => {
            if (!confirm("Убрать новость из публикации?")) return;
            await rpc("archive_news", { p_id: n.id });
            offset = 0;
            list.replaceChildren();
            await load();
          }),
        );
      list.append(node);
    }
    if (!offset && !rows.length) list.append(empty("Новостей пока нет"));
    offset += rows.length;
    more.disabled = rows.length < 20;
    more.dataset.exhausted = String(rows.length < 20);
  }
  function edit(n = null) {
    const f = el(
        "form",
        {},
        el("h2", {}, n ? "Редактировать новость" : "Новая публикация"),
      ),
      title = field(f, "Заголовок", "title", "text", n?.title ?? ""),
      body = field(f, "Текст", "body", "textarea", n?.body ?? "");
    title.maxLength = 160;
    body.maxLength = 40000;
    const category = el(
      "select",
      { "aria-label": "Категория" },
      el("option", { value: "village" }, "Посёлок"),
      ...(mayor ? [el("option", { value: "lands" }, "Капанёвские земли")] : []),
    );
    category.value = n?.category ?? "village";
    const publish = el(
      "select",
      { "aria-label": "Состояние публикации" },
      el("option", { value: "draft" }, "Сохранить черновик"),
      el("option", { value: "published" }, "Опубликовать"),
    );
    publish.value = n?.status === "published" ? "published" : "draft";
    const pinned = el("input", {
      type: "checkbox",
      "aria-label": "Закрепить важную новость",
    });
    pinned.checked = n?.pinned ?? false;
    const preview = el("div", { class: "post-body" }),
      save = el("button", { type: "submit" }, "Сохранить");
    f.append(
      category,
      publish,
      ...(mayor ? [el("label", {}, pinned, "Важная новость")] : []),
      action("Предпросмотр", () =>
        preview.replaceChildren(
          el("h3", {}, title.value),
          el("p", {}, body.value),
        ),
      ),
      preview,
      save,
    );
    const id = n?.id ?? uuid();
    modal(f);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(save, () =>
          rpc("save_news", {
            p_id: id,
            p_category: category.value,
            p_title: title.value,
            p_body: body.value,
            p_publish: publish.value === "published",
            p_pinned: mayor && pinned.checked,
          }),
        );
        document.querySelector("#modal").close();
        offset = 0;
        list.replaceChildren();
        await load();
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  await load();
}
export async function eventsPage(app, session) {
  const roles = await myRoles(session),
    mayor = roles.some((r) => r.role === "mayor");
  app.append(
    el("h1", {}, "Календарь Капани"),
    el("p", {}, "Встречи, соревнования и события посёлка."),
  );
  const list = el("div", { class: "grid" });
  let offset = 0;
  const more = action("Показать ещё", () => load());
  if (mayor)
    app.append(
      action("Создать событие", () => {
        const f = el("form", {}, el("h2", {}, "Новое событие")),
          title = field(f, "Название", "title"),
          description = field(f, "Описание", "description", "textarea"),
          start = field(
            f,
            "Начало по времени устройства",
            "start",
            "datetime-local",
          ),
          end = field(f, "Окончание", "end", "datetime-local"),
          until = field(f, "Регистрация до", "until", "datetime-local"),
          capacity = field(f, "Количество мест", "capacity", "number", "30"),
          address = field(f, "Место встречи", "address");
        capacity.min = 1;
        capacity.max = 10000;
        const save = el("button", { type: "submit" }, "Создать");
        f.append(save);
        const id = uuid();
        modal(f);
        f.onsubmit = async (e) => {
          e.preventDefault();
          try {
            await busy(save, () =>
              rpc("create_event", {
                p_id: id,
                p_title: title.value,
                p_description: description.value,
                p_start: new Date(start.value).toISOString(),
                p_end: new Date(end.value).toISOString(),
                p_until: new Date(until.value).toISOString(),
                p_capacity: Number(capacity.value),
                p_address: address.value,
              }),
            );
            document.querySelector("#modal").close();
            offset = 0;
            list.replaceChildren();
            await load();
          } catch (error) {
            toast(friendly(error));
          }
        };
      }),
    );
  app.append(list, more);
  async function load() {
    const rows = await unwrap(
      client
        .from("events")
        .select("*")
        .order("starts_at", { ascending: false })
        .order("id")
        .range(offset, offset + 19),
    );
    const participation = rows.length
      ? await unwrap(
          client
            .from("event_participants")
            .select("*,profiles!user_id(display_name)")
            .in(
              "event_id",
              rows.map((x) => x.id),
            ),
        )
      : [];
    for (const event of rows) {
      const people = participation.filter(
          (p) => p.event_id === event.id && p.status !== "withdrawn",
        ),
        me = people.find((p) => p.user_id === session.user.id);
      const node = card(
        el("span", { class: "tag" }, status[event.status]),
        el("h2", {}, event.title),
        el("p", {}, new Date(event.starts_at).toLocaleString("ru-RU")),
        el("p", { class: "post-body" }, event.description),
        el("p", {}, event.address),
        el("small", {}, `${people.length} из ${event.capacity} мест`),
      );
      if (event.result_text) node.append(el("p", {}, event.result_text));
      if (me)
        node.append(
          el(
            "p",
            {},
            status[me.status] +
              (me.group_name ? " · " + me.group_name : "") +
              (me.rank ? " · место " + me.rank : ""),
          ),
        );
      if (
        event.status === "open" &&
        new Date(event.registration_until) > new Date()
      )
        node.append(
          action(me ? "Отменить участие" : "Участвовать", async () => {
            await rpc("join_event", { p_id: event.id, p_withdraw: !!me });
            offset = 0;
            list.replaceChildren();
            await load();
          }),
        );
      node.append(
        action("Участники и результаты", () =>
          modal(
            el("h2", {}, event.title),
            ...people
              .sort((a, b) => (a.rank ?? 999999) - (b.rank ?? 999999))
              .map((p) =>
                el(
                  "p",
                  {},
                  p.profiles.display_name +
                    (p.group_name ? " · " + p.group_name : "") +
                    (p.rank ? " · место " + p.rank : ""),
                ),
              ),
            ...(!people.length ? [empty("Пока никто не записался")] : []),
          ),
        ),
      );
      if (mayor && !["completed", "cancelled"].includes(event.status))
        node.append(
          action("Управление событием", () => {
            const f = el("form", {}, el("h2", {}, "Изменить состояние")),
              state = el(
                "select",
                { "aria-label": "Новое состояние" },
                el("option", { value: "closed" }, "Закрыть регистрацию"),
                el("option", { value: "completed" }, "Завершить"),
                el("option", { value: "cancelled" }, "Отменить"),
              ),
              result = field(f, "Итоги или причина", "result", "textarea"),
              save = el("button", { type: "submit" }, "Подтвердить");
            f.prepend(state);
            f.append(save);
            modal(f);
            f.onsubmit = async (e) => {
              e.preventDefault();
              try {
                await busy(save, () =>
                  rpc("event_action", {
                    p_id: event.id,
                    p_status: state.value,
                    p_result: result.value,
                  }),
                );
                document.querySelector("#modal").close();
                offset = 0;
                list.replaceChildren();
                await load();
              } catch (error) {
                toast(friendly(error));
              }
            };
          }),
        );
      list.append(node);
    }
    if (!offset && !rows.length)
      list.append(empty("События ещё не опубликованы"));
    offset += rows.length;
    more.disabled = rows.length < 20;
    more.dataset.exhausted = String(rows.length < 20);
  }
  await load();
}
