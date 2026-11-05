import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, modal, busy, toast, empty } from "./ui.js";
import { uuid } from "./id.js";
import { formatMoney, parseMoney } from "./money.js";
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
export async function businessPanel(b) {
  const [members, payments, account] = await Promise.all([
    unwrap(
      client
        .from("business_members")
        .select("*,profiles!user_id(display_name)")
        .eq("business_id", b.id)
        .limit(100),
    ),
    unwrap(
      client
        .from("payroll_payments")
        .select("*,profiles!user_id(display_name)")
        .eq("business_id", b.id)
        .order("created_at", { ascending: false })
        .limit(30),
    ),
    unwrap(
      client.from("accounts").select("balance").eq("id", b.account_id).single(),
    ),
  ]);
  const page = el(
    "div",
    {},
    el("h2", {}, b.name),
    el("div", { class: "money" }, formatMoney(account.balance)),
    el(
      "p",
      { class: "small" },
      "Фиксированная выплата за календарный месяц по московскому времени. Неполный месяц пока не пересчитывается пропорционально; это должно быть согласовано в условиях вакансии.",
    ),
  );
  page.append(
    action("Пополнить со своего кошелька", () => {
      const f = el("form", {}, el("h2", {}, "Внести средства организации")),
        amount = field(f, "Сумма в К₽", "amount"),
        save = el("button", { type: "submit" }, "Подтвердить перевод"),
        key = uuid();
      f.append(
        el(
          "p",
          {},
          "Средства спишутся с твоего личного виртуального кошелька.",
        ),
        save,
      );
      modal(f);
      f.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await busy(save, () =>
            rpc("fund_business", {
              p_business: b.id,
              p_amount: parseMoney(amount.value),
              p_key: key,
            }),
          );
          await businessPanel(b);
        } catch (error) {
          toast(friendly(error));
        }
      };
    }),
    el("h3", { class: "section" }, "Сотрудники"),
  );
  for (const m of members) {
    const node = card(
      el("h3", {}, m.profiles.display_name),
      el(
        "p",
        {},
        m.position + " · " + (m.active ? "Работает" : "Работа завершена"),
      ),
      el("p", {}, formatMoney(m.salary) + " в месяц"),
    );
    if (m.active)
      node.append(
        action("Выплатить за текущий месяц", async () => {
          if (
            !confirm(
              "Выплатить " +
                formatMoney(m.salary) +
                " за текущий календарный месяц? Повторного списания за этот период не будет.",
            )
          )
            return;
          await rpc("pay_business_salary", {
            p_business: b.id,
            p_user: m.user_id,
          });
          await businessPanel(b);
        }),
        action("Условия и права", () => {
          const f = el("form", {}, el("h2", {}, "Условия работы")),
            position = field(f, "Должность", "position", "text", m.position),
            salary = field(
              f,
              "Фиксированная месячная зарплата в К₽",
              "salary",
              "text",
              String(m.salary / 100),
            ),
            reason = field(f, "Причина изменения", "reason", "textarea"),
            orders = el("input", { type: "checkbox" }),
            catalog = el("input", { type: "checkbox" }),
            save = el("button", { type: "submit" }, "Сохранить");
          orders.checked = m.can_manage_orders;
          catalog.checked = m.can_manage_catalog;
          f.append(
            el("label", { class: "choice" }, orders, "Обработка заказов"),
            el(
              "label",
              { class: "choice" },
              catalog,
              "Редактирование каталога",
            ),
            el(
              "p",
              { class: "small" },
              "Права действуют в разделе «Магазины и заказы».",
            ),
            save,
          );
          modal(f);
          f.onsubmit = async (e) => {
            e.preventDefault();
            try {
              await busy(save, () =>
                rpc("configure_employee", {
                  p_business: b.id,
                  p_user: m.user_id,
                  p_position: position.value,
                  p_salary:
                    salary.value === "0" ? "0" : parseMoney(salary.value),
                  p_orders: orders.checked,
                  p_catalog: catalog.checked,
                  p_reason: reason.value,
                }),
              );
              await businessPanel(b);
            } catch (error) {
              toast(friendly(error));
            }
          };
        }),
      );
    page.append(node);
  }
  if (!members.length)
    page.append(
      empty("Сотрудники появятся после принятия отклика на вакансию"),
    );
  page.append(
    el("h3", { class: "section" }, "История выплат"),
    ...payments.map((p) =>
      card(
        el("strong", {}, p.profiles.display_name),
        el("p", {}, p.period + " · " + formatMoney(p.amount)),
        el("small", { class: "muted" }, "Квитанция " + p.transaction_id),
      ),
    ),
  );
  modal(page);
}
