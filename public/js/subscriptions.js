import { client, unwrap, rpc, friendly } from "./api.js";
import { uuid } from "./id.js";
import { el, card, toast, busy, modal, empty } from "./ui.js";
import { formatMoney } from "./money.js";
export async function subscriptions(app, session) {
  app.append(
    el("h1", {}, "Больше возможностей"),
    el(
      "p",
      {},
      "Подписки за внутреннюю валюту Капани. Оплата и срок действия сохраняются на сервере.",
    ),
  );
  const [plans, current, purchases] = await Promise.all([
    unwrap(
      client
        .from("subscription_plans")
        .select("*")
        .eq("active", true)
        .order("price"),
    ),
    unwrap(
      client
        .from("user_subscriptions")
        .select("*,subscription_plans(name)")
        .eq("user_id", session.user.id)
        .maybeSingle(),
    ),
    unwrap(
      client
        .from("subscription_purchases")
        .select("*,subscription_plans(name)")
        .order("created_at", { ascending: false })
        .limit(30),
    ),
  ]);
  if (current)
    app.append(
      card(
        el("h2", {}, current.subscription_plans.name),
        el(
          "p",
          {},
          new Date(current.expires_at) > new Date()
            ? `Действует до ${new Date(current.expires_at).toLocaleString("ru-RU")}`
            : "Срок подписки завершён",
        ),
      ),
    );
  app.append(
    el(
      "p",
      { class: "notice" },
      "Автоматическое продление пока не подключено. Покупка продлевает тот же тариф; сменить активный тариф можно после окончания срока.",
    ),
  );
  const grid = el("div", { class: "grid" });
  for (const plan of plans) {
    const node = card(
      el("h2", {}, plan.name),
      el("div", { class: "money" }, formatMoney(plan.price)),
      el("p", {}, `На ${plan.days} дней`),
      ...plan.benefits.map((t) => el("p", {}, t)),
    );
    const recipient = el("input", {
      placeholder: "Никнейм для подарка, необязательно",
      "aria-label": "Никнейм получателя подарка",
    });
    const buy = el(
      "button",
      {
        onClick: async (e) => {
          try {
            await busy(e.currentTarget, async () => {
              let target = session.user.id;
              if (recipient.value.trim()) {
                const users = await unwrap(
                  client
                    .from("profiles")
                    .select("id,username")
                    .ilike("username", recipient.value.trim())
                    .limit(5),
                );
                target = users.find(
                  (u) =>
                    u.username.toLowerCase() ===
                    recipient.value.trim().toLowerCase(),
                )?.id;
                if (!target) throw Error("Получатель не найден");
              }
              const key = uuid();
              const confirm = el(
                "button",
                {
                  onClick: async (event) => {
                    try {
                      await busy(event.currentTarget, async () => {
                        await rpc("buy_subscription", {
                          p_plan: plan.code,
                          p_recipient: target,
                          p_key: key,
                        });
                        document.querySelector("#modal").close();
                        toast("Подписка активирована");
                        location.reload();
                      });
                    } catch (error) {
                      toast(friendly(error));
                    }
                  },
                },
                "Подтвердить оплату",
              );
              modal(
                el("h2", {}, plan.name),
                el(
                  "p",
                  {},
                  `Стоимость ${formatMoney(plan.price)}. Получатель ${recipient.value.trim() || "ты"}.`,
                ),
                confirm,
              );
            });
          } catch (error) {
            toast(friendly(error));
          }
        },
      },
      "Купить или продлить",
    );
    node.append(recipient, el("div", { class: "actions" }, buy));
    grid.append(node);
  }
  app.append(grid, el("h2", { class: "section" }, "История покупок"));
  app.append(
    ...purchases.map((p) =>
      card(
        el("strong", {}, p.subscription_plans.name),
        el(
          "p",
          {},
          `${formatMoney(p.price)} · ${new Date(p.created_at).toLocaleString("ru-RU")}`,
        ),
      ),
    ),
    ...(!purchases.length ? [empty("Покупок пока нет")] : []),
  );
}
