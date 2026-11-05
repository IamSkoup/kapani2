import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, modal, busy, toast, empty } from "./ui.js";
import { uuid } from "./id.js";
import { formatMoney, parseMoney } from "./money.js";
const states = {
  reserved: "Оплата в резерве",
  accepted: "Заказ принят",
  ready: "Готов к выдаче",
  completed: "Получен",
  cancelled: "Отменён",
  disputed: "Открыт спор",
};
const act = (name, fn) =>
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
export async function shopPage(app, session) {
  const [businesses, members, roles] = await Promise.all([
    unwrap(
      client
        .from("businesses")
        .select("*")
        .eq("status", "active")
        .order("name")
        .limit(100),
    ),
    unwrap(
      client
        .from("business_members")
        .select("*")
        .eq("user_id", session.user.id)
        .eq("active", true),
    ),
    unwrap(
      client.from("user_roles").select("role").eq("user_id", session.user.id),
    ),
  ]);
  const mayor = roles.some((r) => r.role === "mayor");
  let selected = null,
    products = [],
    cart = new Map(),
    checkoutKey = null,
    checkoutFingerprint = null,
    viewVersion = 0;
  const selection = el(
    "select",
    { "aria-label": "Организация" },
    el("option", { value: "" }, "Выбрать организацию"),
    ...businesses.map((b) => el("option", { value: b.id }, b.name)),
  );
  const catalogue = el("section", { class: "grid" }),
    basket = el("section", { class: "card" }),
    orders = el("section", { class: "section" }),
    controls = el("div", { class: "actions" });
  app.append(
    el("h1", {}, "Магазины Капани"),
    el(
      "p",
      {},
      "Заказы с самовывозом. Оплата остаётся в резерве до подтверждения получения. Доставка пока не подключена.",
    ),
    selection,
    controls,
    catalogue,
    basket,
    orders,
  );
  const permission = (b, type) =>
    b.owner_id === session.user.id ||
    members.some((m) => m.business_id === b.id && m[type]);
  selection.onchange = async () => {
    try {
      cart.clear();
      selected = businesses.find((b) => b.id === selection.value);
      await loadCatalogue();
    } catch (e) {
      toast(friendly(e));
    }
  };
  async function loadCatalogue() {
    const version = ++viewVersion;
    controls.replaceChildren();
    catalogue.replaceChildren();
    basket.replaceChildren();
    if (!selected) {
      catalogue.append(empty("Выбери организацию, чтобы открыть каталог"));
      return;
    }
    const b = selected;
    products = await unwrap(
      client
        .from("business_products")
        .select("*")
        .eq("business_id", b.id)
        .order("created_at", { ascending: false })
        .limit(100),
    );
    if (version !== viewVersion) return;
    if (permission(b, "can_manage_catalog"))
      controls.append(act("Добавить товар", () => productEditor(b)));
    catalogue.replaceChildren(
      ...products.map((p) => {
        const node = card(
          el("h2", {}, p.title),
          el("p", {}, p.description),
          el("strong", {}, formatMoney(p.price)),
          el(
            "p",
            { class: "small muted" },
            `Доступно ${p.stock} · ${p.active ? "В продаже" : "Скрыт"}`,
          ),
        );
        if (p.active && p.stock > 0 && b.owner_id !== session.user.id)
          node.append(
            act("В корзину", () => {
              const quantity = (cart.get(p.id) ?? 0) + 1;
              if (quantity > Math.min(99, p.stock))
                throw Error("Больше товара сейчас нет");
              cart.set(p.id, quantity);
              drawCart();
            }),
          );
        if (permission(b, "can_manage_catalog"))
          node.append(act("Изменить", () => productEditor(b, p)));
        return node;
      }),
    );
    if (!products.length) catalogue.append(empty("Каталог пока пуст"));
    drawCart();
  }
  function drawCart() {
    basket.replaceChildren(el("h2", {}, "Корзина"));
    let total = 0n;
    for (const [id, quantity] of cart) {
      const p = products.find((p) => p.id === id);
      if (!p) continue;
      total += BigInt(p.price) * BigInt(quantity);
      basket.append(
        el(
          "div",
          { class: "row" },
          el("span", {}, `${p.title} × ${quantity}`),
          act("Уменьшить", () => {
            if (quantity === 1) cart.delete(id);
            else cart.set(id, quantity - 1);
            drawCart();
          }),
          act("Убрать", () => {
            cart.delete(id);
            drawCart();
          }),
        ),
      );
    }
    if (!cart.size) {
      basket.append(empty("Добавь товары из каталога"));
      return;
    }
    const comment = el("textarea", {
      "aria-label": "Комментарий к заказу",
      placeholder: "Комментарий к заказу",
      maxlength: "2000",
    });
    basket.append(
      el("p", { class: "money" }, formatMoney(total.toString())),
      comment,
      act("Подтвердить и зарезервировать оплату", async () => {
        const b = selected;
        const items = [...cart].map(([product_id, quantity]) => ({
          product_id,
          quantity,
        }));
        const cartSnapshot = JSON.stringify([...cart]);
        const fingerprint = JSON.stringify([
          b.id,
          items,
          total.toString(),
          comment.value,
        ]);
        if (checkoutFingerprint !== fingerprint) {
          checkoutKey = uuid();
          checkoutFingerprint = fingerprint;
        }
        if (
          !confirm(
            `Зарезервировать ${formatMoney(total.toString())}? Получение — самовывоз.`,
          )
        )
          return;
        await rpc("checkout_business", {
          p_business: b.id,
          p_items: items,
          p_expected_total: total.toString(),
          p_comment: comment.value,
          p_key: checkoutKey,
        });
        if (
          selected?.id === b.id &&
          JSON.stringify([...cart]) === cartSnapshot
        ) {
          cart.clear();
        }
        if (checkoutFingerprint === fingerprint) {
          checkoutKey = null;
          checkoutFingerprint = null;
        }
        await loadCatalogue();
        await loadOrders();
      }),
    );
  }
  function productEditor(b, p = {}) {
    const f = el(
      "form",
      {},
      el("h2", {}, p.id ? "Изменить товар" : "Новый товар"),
    );
    const title = field(f, "Название", "title", "text", p.title ?? ""),
      description = field(
        f,
        "Описание",
        "description",
        "textarea",
        p.description ?? "",
      ),
      price = field(
        f,
        "Цена в К₽",
        "price",
        "text",
        p.price ? String(p.price / 100) : "",
      ),
      stock = field(
        f,
        "Доступный остаток без уже зарезервированных товаров",
        "stock",
        "number",
        String(p.stock ?? 0),
      );
    stock.min = "0";
    stock.max = "1000000";
    const active = el("input", { type: "checkbox" });
    active.checked = p.active ?? true;
    const submit = el("button", { type: "submit" }, "Сохранить");
    f.append(el("label", {}, active, " В продаже"), submit);
    modal(f);
    const id = p.id ?? uuid();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(submit, async () => {
          await rpc("save_business_product", {
            p_id: id,
            p_business: b.id,
            p_title: title.value,
            p_description: description.value,
            p_price: parseMoney(price.value),
            p_stock: Number(stock.value),
            p_active: active.checked,
          });
          document.querySelector("#modal").close();
          await loadCatalogue();
        });
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  async function orderDetails(o) {
    const [items, history] = await Promise.all([
      unwrap(
        client.from("business_order_items").select("*").eq("order_id", o.id),
      ),
      unwrap(
        client
          .from("business_order_history")
          .select("*")
          .eq("order_id", o.id)
          .order("id"),
      ),
    ]);
    modal(
      el(
        "div",
        {},
        el("h2", {}, "Заказ " + o.id.slice(0, 8)),
        el("p", {}, o.comment),
        ...items.map((i) =>
          el(
            "p",
            {},
            `${i.title} × ${i.quantity} · ${formatMoney(i.unit_price)}`,
          ),
        ),
        el("h3", {}, "История"),
        ...history.map((h) =>
          el(
            "p",
            {},
            new Date(h.created_at).toLocaleString("ru-RU") +
              " · " +
              (states[h.status] ?? h.status) +
              (h.reason ? " · " + h.reason : ""),
          ),
        ),
      ),
    );
  }
  function decide(o, action) {
    if (["dispute", "refund_dispute", "settle_dispute"].includes(action)) {
      const f = el("form", {}, el("h2", {}, "Обоснование решения")),
        reason = field(
          f,
          "Причина, не менее 10 символов",
          "reason",
          "textarea",
        ),
        submit = el("button", { type: "submit" }, "Подтвердить");
      reason.minLength = 10;
      f.append(submit);
      modal(f);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await busy(submit, () =>
            rpc("business_order_action", {
              p_order: o.id,
              p_action: action,
              p_reason: reason.value,
            }),
          );
          document.querySelector("#modal").close();
          await loadOrders();
          await loadCatalogue();
        } catch (error) {
          toast(friendly(error));
        }
      };
      return;
    }
    return (async () => {
      if (
        ["cancel", "receive"].includes(action) &&
        !confirm(
          action === "receive"
            ? "Товар действительно получен? Деньги поступят организации."
            : "Отменить заказ и вернуть резерв?",
        )
      )
        return;
      await rpc("business_order_action", { p_order: o.id, p_action: action });
      await loadOrders();
      await loadCatalogue();
    })();
  }
  async function loadOrders() {
    const data = await unwrap(
      client
        .from("business_orders")
        .select("*,businesses(name,owner_id)")
        .order("created_at", { ascending: false })
        .limit(50),
    );
    orders.replaceChildren(el("h2", {}, "Заказы"), act("Обновить", loadOrders));
    for (const o of data) {
      const mine = o.buyer_id === session.user.id,
        b = { id: o.business_id, owner_id: o.businesses.owner_id },
        manager = permission(b, "can_manage_orders");
      const node = card(
        el("h3", {}, o.businesses.name),
        el("p", {}, states[o.status] + " · " + formatMoney(o.total)),
        act("Состав и история", () => orderDetails(o)),
      );
      if (manager && o.status === "reserved")
        node.append(act("Принять", () => decide(o, "accept")));
      if (manager && o.status === "accepted")
        node.append(act("Готов к выдаче", () => decide(o, "ready")));
      if (mine && o.status === "ready")
        node.append(act("Подтвердить получение", () => decide(o, "receive")));
      if (
        (manager && ["reserved", "accepted", "ready"].includes(o.status)) ||
        (mine && o.status === "reserved")
      )
        node.append(act("Отменить с возвратом", () => decide(o, "cancel")));
      if (mine && ["reserved", "accepted", "ready"].includes(o.status))
        node.append(act("Открыть спор", () => decide(o, "dispute")));
      if (
        mayor &&
        o.status === "disputed" &&
        !mine &&
        b.owner_id !== session.user.id
      )
        node.append(
          act("Вернуть покупателю", () => decide(o, "refund_dispute")),
          act("Перечислить организации", () => decide(o, "settle_dispute")),
        );
      orders.append(node);
    }
    if (!data.length) orders.append(empty("Заказов пока нет"));
  }
  await loadCatalogue();
  await loadOrders();
  if (mayor) {
    const disputes = el("section", { class: "section" });
    app.append(disputes);
    async function loadDisputes() {
      const data = await unwrap(
        client
          .from("orders")
          .select("*")
          .eq("status", "disputed")
          .order("created_at")
          .limit(50),
      );
      disputes.replaceChildren(el("h2", {}, "Споры маркетплейса"));
      for (const o of data) {
        const node = card(el("p", {}, o.id + " · " + formatMoney(o.total)));
        for (const [refund, label] of [
          [true, "Вернуть покупателю"],
          [false, "Перечислить продавцу"],
        ])
          node.append(
            act(label, () => {
              const f = el("form", {}, el("h3", {}, label)),
                reason = field(f, "Обоснование решения", "reason", "textarea"),
                submit = el("button", { type: "submit" }, "Подтвердить");
              reason.minLength = 10;
              f.append(submit);
              modal(f);
              f.onsubmit = async (e) => {
                e.preventDefault();
                try {
                  await busy(submit, () =>
                    rpc("resolve_market_dispute", {
                      p_order: o.id,
                      p_refund: refund,
                      p_reason: reason.value,
                    }),
                  );
                  document.querySelector("#modal").close();
                  await loadDisputes();
                } catch (error) {
                  toast(friendly(error));
                }
              };
            }),
          );
        disputes.append(node);
      }
      if (!data.length) disputes.append(empty("Открытых споров нет"));
    }
    await loadDisputes();
  }
}
