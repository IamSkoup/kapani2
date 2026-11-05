import { client, unwrap, friendly } from "./api.js";
import { el, card, empty, busy, toast } from "./ui.js";
export async function notificationsPage(app) {
  let disposed = false,
    cursor = null,
    loading = false,
    channel = null;
  const seen = new Set();
  const categories = {
    messages: "Сообщения",
    finance: "Финансы",
    market: "Покупки",
    orders: "Заказы",
    work: "Работа",
    administration: "Мэрия",
    events: "События",
    news: "Новости",
    education: "Образование",
    system: "Система",
  };
  app.append(
    el("h1", {}, "Уведомления"),
    el(
      "p",
      {},
      "События твоего аккаунта. Уведомления браузера пока не подключены.",
    ),
  );
  const filter = el(
      "select",
      { "aria-label": "Категория уведомлений" },
      el("option", { value: "" }, "Все категории"),
      ...Object.entries(categories).map(([value, name]) =>
        el("option", { value }, name),
      ),
    ),
    list = el("div", { class: "section" }),
    more = el("button", { type: "button" }, "Загрузить ещё");
  app.append(filter, list, more);
  function draw(n, prepend = false) {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const node = card(
        el(
          "div",
          { class: "row" },
          el("span", { class: "tag" }, categories[n.category] ?? "Система"),
          el("small", {}, new Date(n.created_at).toLocaleString("ru-RU")),
        ),
      ),
      link = el(
        "a",
        {
          class: "notification-title",
          href: n.href?.startsWith("#") ? n.href : "#home",
        },
        n.title,
      ),
      state = el(
        "small",
        { class: "muted" },
        n.read_at ? "Прочитано" : "Новое",
      );
    node.append(link, el("p", {}, n.body), state);
    const mark = async () => {
      await unwrap(
        client
          .from("notifications")
          .update({ read_at: new Date().toISOString() })
          .eq("id", n.id),
      );
      state.textContent = "Прочитано";
    };
    link.onclick = () => mark().catch(() => {});
    if (!n.read_at) {
      const button = el(
        "button",
        {
          type: "button",
          class: "quiet",
          onClick: async (e) => {
            const target = e.currentTarget;
            try {
              await busy(target, mark);
              target.remove();
            } catch (error) {
              toast(friendly(error));
            }
          },
        },
        "Прочитано",
      );
      node.append(button);
    }
    if (prepend) list.prepend(node);
    else list.append(node);
  }
  async function load() {
    if (loading || disposed) return;
    loading = true;
    more.disabled = true;
    try {
      let q = client
        .from("notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(30);
      if (filter.value) q = q.eq("category", filter.value);
      if (cursor)
        q = q.or(
          `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
        );
      const data = await unwrap(q);
      if (disposed) return;
      data.forEach((n) => draw(n));
      cursor = data.at(-1) ?? cursor;
      more.disabled = data.length < 30;
      if (!seen.size) list.replaceChildren(empty("Здесь пока тихо"));
    } catch (error) {
      toast(friendly(error));
      more.disabled = false;
    } finally {
      loading = false;
    }
  }
  more.onclick = load;
  filter.onchange = () => {
    cursor = null;
    seen.clear();
    list.replaceChildren();
    load();
  };
  channel = client
    .channel("notifications-center")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications" },
      (payload) => {
        if (disposed || (filter.value && filter.value !== payload.new.category))
          return;
        list.querySelector(".empty")?.remove();
        draw(payload.new, true);
      },
    )
    .subscribe();
  await load();
  return () => {
    disposed = true;
    if (channel) client.removeChannel(channel);
  };
}
