import { uuid } from "./id.js";
import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, busy, toast, empty, modal } from "./ui.js";
import { parseMoney, formatMoney } from "./money.js";
const states = {
  reserved: "Оплата в резерве",
  accepted: "Принят продавцом",
  completed: "Получен",
  cancelled: "Отменён",
  disputed: "На рассмотрении",
};
export async function market(app, session) {
  const action = (label, fn) =>
    el(
      "button",
      {
        class: "quiet",
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
  app.append(
    el("h1", {}, "Маркетплейс"),
    el(
      "p",
      {},
      "Покупки у своих. Деньги остаются в резерве до подтверждения получения.",
    ),
  );
  const form = el("form", { class: "card" }, el("h2", {}, "Новое объявление"));
  const title = field(form, "Название", "title");
  title.maxLength = 160;
  const description = field(form, "Описание", "description", "textarea");
  const price = field(form, "Цена в К₽", "price");
  price.inputMode = "decimal";
  const stock = field(form, "Количество", "stock", "number", "1");
  stock.min = 1;
  stock.max = 100000;
  const submit = el("button", { type: "submit" }, "Опубликовать");
  form.append(submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(submit, async () => {
        await unwrap(
          client.from("listings").insert({
            seller_id: session.user.id,
            title: title.value,
            description: description.value,
            price: parseMoney(price.value),
            stock: Number(stock.value),
          }),
        );
        await refresh();
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  app.append(form);
  const content = el("div");
  app.append(content);
  async function refresh() {
    content.replaceChildren(empty("Загрузка…"));
    const [items, orders] = await Promise.all([
      unwrap(
        client
          .from("listings")
          .select("*,profiles!seller_id(display_name)")
          .eq("active", true)
          .order("created_at", { ascending: false })
          .limit(40),
      ),
      unwrap(
        client
          .from("orders")
          .select("*,listings(title)")
          .order("created_at", { ascending: false })
          .limit(40),
      ),
    ]);
    content.replaceChildren(el("h2", { class: "section" }, "Объявления"));
    const grid = el("div", { class: "grid" });
    for (const item of items) {
      const node = card(
        el("h3", {}, item.title),
        el("p", {}, item.description),
        el("strong", { class: "money" }, formatMoney(item.price)),
        el(
          "p",
          { class: "small" },
          `${item.profiles.display_name} · Доступно ${item.stock}`,
        ),
      );
      if (item.seller_id !== session.user.id && item.stock > 0)
        node.append(
          action("Купить", async () => {
            const key = uuid();
            const d = modal(
              el("h2", {}, "Оформление заказа"),
              el(
                "p",
                {},
                `${item.title}. Цена за одну единицу ${formatMoney(item.price)}. Средства будут зарезервированы. Самовывоз согласуется с продавцом. Доставка пока не подключена.`,
              ),
              action("Подтвердить заказ", async () => {
                await rpc("purchase", {
                  p_listing: item.id,
                  p_quantity: 1,
                  p_key: key,
                });
                d.close();
                await refresh();
              }),
            );
          }),
        );
      grid.append(node);
    }
    content.append(
      grid,
      ...(!items.length ? [empty("Объявлений пока нет")] : []),
      el("h2", { class: "section" }, "Мои покупки и продажи"),
    );
    for (const o of orders) {
      const node = card(
        el("h3", {}, o.listings.title),
        el("p", {}, `${states[o.status]} · ${formatMoney(o.total)}`),
      );
      const controls = el("div", { class: "actions" });
      async function change(command) {
        await rpc("order_action", { p_order: o.id, p_action: command });
        await refresh();
      }
      if (o.status === "reserved" && o.seller_id === session.user.id)
        controls.append(action("Принять", () => change("accept")));
      if (o.status === "accepted" && o.buyer_id === session.user.id)
        controls.append(
          action("Подтвердить получение", async () => {
            if (
              confirm("Товар действительно получен? Оплата поступит продавцу.")
            )
              await change("receive");
          }),
        );
      if (["reserved", "accepted"].includes(o.status))
        controls.append(
          action("Отменить и вернуть оплату", () => change("cancel")),
        );
      if (o.status === "accepted")
        controls.append(action("Открыть спор", () => change("dispute")));
      node.append(controls);
      content.append(node);
    }
    if (!orders.length) content.append(empty("Здесь появятся заказы"));
  }
  await refresh();
}
