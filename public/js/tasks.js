import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, empty, busy, toast } from "./ui.js";
import { uuid } from "./id.js";
import { formatMoney, parseMoney } from "./money.js";
const act = (label, fn) =>
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
export async function tasksPage(app, session) {
  const roles = await unwrap(
    client.from("user_roles").select("role").eq("user_id", session.user.id),
  );
  const mayor = roles.some((r) => r.role === "mayor"),
    catalog = el("div", { class: "grid" }),
    history = el("section", { class: "section" });
  app.append(
    el("h1", {}, "Задания"),
    el(
      "p",
      {},
      "Прогресс подтверждается действиями на сервере. Награды начисляются в условной валюте Капани. Периоды считаются по московскому времени.",
    ),
    act("Обновить прогресс", refresh),
    catalog,
    history,
  );
  async function refresh() {
    const [tasks, claims] = await Promise.all([
      rpc("my_tasks"),
      unwrap(
        client
          .from("task_claims")
          .select("*,task_periods(task_definitions(title))")
          .order("created_at", { ascending: false })
          .limit(30),
      ),
    ]);
    catalog.replaceChildren(
      ...tasks.map((t) => {
        const box = card(
          el("h2", {}, t.title),
          el("p", {}, t.description),
          el(
            "p",
            {},
            `${Math.min(t.progress, t.target)} из ${t.target} · ${formatMoney(t.reward)}`,
          ),
          el(
            "p",
            { class: "small muted" },
            t.ends_at
              ? "До " +
                  new Date(t.ends_at).toLocaleString("ru-RU", {
                    timeZone: "Europe/Moscow",
                  })
              : "Одноразовое задание",
          ),
        );
        if (t.subscribers_only)
          box.append(el("span", { class: "tag" }, "Для подписчиков"));
        if (t.claimed) box.append(el("p", {}, "Награда получена"));
        else if (!t.eligible)
          box.append(
            el(
              "p",
              {},
              "Нужно подтверждение жителя и, если указано, действующая подписка. Автор не получает награду своего задания.",
            ),
          );
        else if (t.progress >= t.target)
          box.append(
            act("Получить награду", async () => {
              await rpc("claim_task", { p_period: t.period_id });
              await refresh();
            }),
          );
        else
          box.append(el("p", { class: "muted" }, "Условие ещё не выполнено"));
        if (mayor)
          box.append(
            act("Приостановить задание", async () => {
              if (confirm("Приостановить выдачу наград? История сохранится.")) {
                await rpc("set_task_active", {
                  p_id: t.task_id,
                  p_active: false,
                });
                await refresh();
              }
            }),
          );
        return box;
      }),
    );
    if (!tasks.length) catalog.append(empty("Сейчас нет активных заданий"));
    history.replaceChildren(
      el("h2", {}, "Последние награды"),
      ...claims.map((c) =>
        card(
          el(
            "strong",
            {},
            c.task_periods?.task_definitions?.title ?? "Задание",
          ),
          el("p", {}, formatMoney(c.reward)),
          el("small", {}, new Date(c.created_at).toLocaleString("ru-RU")),
        ),
      ),
    );
    if (!claims.length)
      history.append(empty("Полученные награды появятся здесь"));
  }
  if (mayor) {
    const form = el("form", {}, el("h2", {}, "Новое задание"));
    const title = field(form, "Название", "title"),
      description = field(
        form,
        "Проверяемое условие",
        "description",
        "textarea",
      );
    const condition = el(
      "select",
      { "aria-label": "Тип условия" },
      ...Object.entries({
        post_created: "Публикация",
        purchase_completed: "Завершённая покупка",
        exam_passed: "Сданный экзамен",
      }).map(([value, label]) => el("option", { value }, label)),
    );
    const cadence = el(
      "select",
      { "aria-label": "Повторение" },
      ...Object.entries({
        once: "Одноразовое",
        daily: "Ежедневное",
        weekly: "Еженедельное",
      }).map(([value, label]) => el("option", { value }, label)),
    );
    form.append(
      condition,
      cadence,
      el(
        "p",
        { class: "small muted" },
        "Повторяемыми могут быть только задания на завершённые покупки. Условия учитываются после создания задания и внутри текущего периода. Цены и условия существующего задания не меняются.",
      ),
    );
    const target = field(form, "Количество действий", "target", "number", "1"),
      reward = field(form, "Награда в К₽", "reward", "text", "10");
    target.min = "1";
    target.max = "100";
    const premium = el("input", { type: "checkbox" });
    form.append(el("label", {}, premium, " Только с действующей подпиской"));
    const submit = el("button", { type: "submit" }, "Создать задание");
    form.append(submit);
    let id = uuid();
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(submit, async () => {
          await rpc("create_task", {
            p_id: id,
            p_title: title.value,
            p_description: description.value,
            p_condition: condition.value,
            p_cadence: cadence.value,
            p_target: Number(target.value),
            p_reward: parseMoney(reward.value),
            p_subscribers: premium.checked,
          });
          id = uuid();
          form.reset();
          await refresh();
        });
      } catch (error) {
        toast(friendly(error));
      }
    };
    const details = el(
      "details",
      {},
      el("summary", {}, "Управление заданиями"),
      form,
    );
    app.append(details);
  }
  if (mayor) {
    const paused = el("section", { class: "section" });
    app.append(paused);
    const rows = await unwrap(
      client
        .from("task_definitions")
        .select("id,title")
        .eq("active", false)
        .order("created_at", { ascending: false })
        .limit(100),
    );
    if (rows.length) paused.append(el("h2", {}, "Приостановленные задания"));
    for (const t of rows) {
      const row = card(el("strong", {}, t.title));
      row.append(
        act("Возобновить", async () => {
          await rpc("set_task_active", { p_id: t.id, p_active: true });
          row.remove();
          await refresh();
        }),
      );
      paused.append(row);
    }
  }
  await refresh();
}
