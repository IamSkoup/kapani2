import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, modal, busy, toast, empty } from "./ui.js";
import { uuid } from "./id.js";
import { formatMoney, parseMoney } from "./money.js";
const action = (label, fn) =>
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
    label,
  );
export async function rentalsPage(app, session) {
  const roles = await unwrap(
      client.from("user_roles").select("role").eq("user_id", session.user.id),
    ),
    mayor = roles.some((r) => r.role === "mayor");
  app.append(
    el("h1", {}, "Помещение для своего дела"),
    el(
      "p",
      {},
      "Внутренняя виртуальная аренда Капани. Оплата за полный срок резервируется заранее. До даты начала отмена возвращает весь резерв. После начала досрочное освобождение не возвращает оплату. Даты считаются по московскому времени.",
    ),
  );
  const filters = el("form", { class: "card" }),
    start = field(
      filters,
      "Дата начала",
      "start",
      "date",
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(
        new Date(),
      ),
    ),
    days = field(filters, "Количество дней", "days", "number", "7"),
    find = el("button", { type: "submit" }, "Найти свободные");
  days.min = 1;
  days.max = 365;
  filters.append(find);
  app.append(filters);
  const grid = el("div", { class: "grid" }),
    history = el("div", { class: "section" });
  app.append(grid, history);
  filters.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(find, search);
    } catch (error) {
      toast(friendly(error));
    }
  };
  if (mayor) app.prepend(action("Добавить здание", () => editor()));
  async function search() {
    const buildings = await rpc("available_buildings", {
      p_start: start.value,
      p_days: Number(days.value),
    });
    grid.replaceChildren(
      ...buildings.map((b) => {
        const total = BigInt(b.daily_price) * BigInt(days.value),
          node = card(
            el("h2", {}, b.title),
            el("p", {}, b.description),
            el("p", {}, b.address),
            el("div", { class: "money" }, formatMoney(total)),
            el(
              "p",
              { class: "small" },
              formatMoney(b.daily_price) + " в сутки",
            ),
            action("Оформить аренду", () => {
              const key = uuid(),
                p_start = start.value,
                p_days = Number(days.value);
              modal(
                el("h2", {}, "Подтвердить аренду"),
                el(
                  "p",
                  {},
                  `${b.title}. С ${p_start} на ${p_days} дней. К резервированию ${formatMoney(BigInt(b.daily_price) * BigInt(p_days))}.`,
                ),
                el(
                  "p",
                  { class: "notice" },
                  "Отмена с возвратом доступна только до даты начала. После начала оплата срока не возвращается.",
                ),
                action("Подтвердить и зарезервировать", async () => {
                  await rpc("rent_building", {
                    p_building: b.id,
                    p_start,
                    p_days,
                    p_expected_daily: b.daily_price,
                    p_key: key,
                  });
                  document.querySelector("#modal").close();
                  await search();
                  await loadHistory();
                }),
              );
            }),
          );
        if (mayor) node.append(action("Изменить", () => editor(b)));
        return node;
      }),
    );
    if (!buildings.length)
      grid.append(empty("На выбранный срок свободных помещений нет"));
  }
  async function loadHistory() {
    const leases = await unwrap(
      client
        .from("leases")
        .select("*,buildings(title,daily_price)")
        .eq("tenant_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(50),
    );
    history.replaceChildren(el("h2", {}, "Мои договоры"));
    for (const l of leases) {
      const statuses = {
          active: "Срок забронирован",
          released: "Освобождено",
          cancelled: "Отменено",
          expired: "Срок завершён",
        },
        node = card(
          el("h3", {}, l.buildings.title),
          el("span", { class: "tag" }, statuses[l.status]),
          el(
            "p",
            {},
            `С ${l.starts_on} до ${l.ends_on}, дата окончания не включается.`,
          ),
          action("Платежи", async () => {
            const rows = await unwrap(
              client
                .from("lease_payments")
                .select("*")
                .eq("lease_id", l.id)
                .order("created_at"),
            );
            modal(
              el("h2", {}, "История оплаты"),
              ...rows.map((p) =>
                card(
                  el("strong", {}, formatMoney(p.amount)),
                  el("p", {}, `${p.starts_on} — ${p.ends_on}`),
                  el("small", {}, "Квитанция " + p.transaction_id),
                ),
              ),
            );
          }),
        );
      if (l.status === "active")
        node.append(
          action("Продлить", () => {
            const f = el("form", {}, el("h2", {}, "Продление")),
              days = field(f, "Добавить дней", "days", "number", "7"),
              save = el("button", { type: "submit" }, "Подтвердить"),
              quote = el(
                "p",
                {},
                "Тариф " + formatMoney(l.buildings.daily_price) + " за сутки.",
              );
            days.min = 1;
            days.max = 365;
            f.append(quote, save);
            const key = uuid();
            modal(f);
            days.oninput = () => {
              if (/^\d+$/.test(days.value))
                quote.textContent =
                  "К оплате " +
                  formatMoney(
                    BigInt(days.value) * BigInt(l.buildings.daily_price),
                  );
            };
            days.oninput();
            f.onsubmit = async (e) => {
              e.preventDefault();
              try {
                await busy(save, () =>
                  rpc("renew_lease", {
                    p_lease: l.id,
                    p_days: Number(days.value),
                    p_expected_daily: l.buildings.daily_price,
                    p_key: key,
                  }),
                );
                document.querySelector("#modal").close();
                await loadHistory();
              } catch (error) {
                toast(friendly(error));
              }
            };
          }),
          action("Освободить / отменить", async () => {
            if (
              !confirm(
                "Освободить помещение? До начала резерв вернётся. После начала возврата за оставшиеся дни не будет.",
              )
            )
              return;
            await rpc("release_lease", { p_lease: l.id });
            await loadHistory();
            await search();
          }),
          action("Привязать бизнес", async () => {
            const businesses = await unwrap(
              client
                .from("businesses")
                .select("id,name")
                .eq("owner_id", session.user.id)
                .eq("status", "active"),
            );
            const select = el(
              "select",
              { "aria-label": "Организация" },
              ...businesses.map((b) => el("option", { value: b.id }, b.name)),
            );
            modal(
              el("h2", {}, "Помещение организации"),
              el("p", {}, "Привязка доступна после начала срока аренды."),
              select,
              action("Сохранить", async () => {
                if (!select.value) throw Error("Сначала открой бизнес");
                await rpc("bind_business_lease", {
                  p_business: select.value,
                  p_lease: l.id,
                });
                document.querySelector("#modal").close();
                toast("Помещение связано с бизнесом");
              }),
            );
          }),
        );
      history.append(node);
    }
    if (!leases.length)
      history.append(empty("У тебя пока нет договоров аренды"));
  }
  function editor(b = null) {
    const f = el("form", {}, el("h2", {}, "Объект аренды")),
      title = field(f, "Название", "title", "text", b?.title ?? ""),
      description = field(
        f,
        "Описание и условия",
        "description",
        "textarea",
        b?.description ?? "",
      ),
      address = field(f, "Адрес", "address", "text", b?.address ?? ""),
      price = field(
        f,
        "К₽ в сутки",
        "price",
        "text",
        String((b?.daily_price ?? 10000) / 100),
      ),
      active = el(
        "select",
        { "aria-label": "Доступность" },
        el("option", { value: "true" }, "Предлагать в аренду"),
        el("option", { value: "false" }, "Скрыть из свободных"),
      ),
      save = el("button", { type: "submit" }, "Сохранить");
    active.value = String(b?.active ?? true);
    const id = b?.id ?? uuid();
    f.append(active, save);
    modal(f);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(save, () =>
          rpc("save_building", {
            p_id: id,
            p_title: title.value,
            p_description: description.value,
            p_address: address.value,
            p_daily: parseMoney(price.value),
            p_active: active.value === "true",
            p_latitude: b?.latitude ?? null,
            p_longitude: b?.longitude ?? null,
          }),
        );
        document.querySelector("#modal").close();
        await search();
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  await search();
  await loadHistory();
}
