import { businessPanel } from "./business-panel.js";
import { uuid } from "./id.js";
import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, busy, toast, empty, modal } from "./ui.js";
import { parseMoney, formatMoney } from "./money.js";
const labels = {
  pending: "На рассмотрении",
  approved: "Одобрена",
  rejected: "Отклонена",
  needs_info: "Нужны уточнения",
  accepted: "Принят",
  withdrawn: "Отозвана",
  ended: "Работа завершена",
  new: "Новое",
  closed: "Закрыто",
  booked: "Запись подтверждена",
  cancelled: "Отменена",
  completed: "Приём завершён",
};
export const action = (label, fn) =>
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
async function rows(table, columns = "*") {
  return unwrap(client.from(table).select(columns).limit(50));
}
function formBox(title, fields, submit) {
  const form = el("form", {}, el("h2", {}, title));
  const inputs = {};
  for (const f of fields) {
    inputs[f.name] = field(
      form,
      f.label,
      f.name,
      f.type ?? "text",
      f.value ?? "",
    );
    if (f.optional) inputs[f.name].required = false;
  }
  const button = el("button", { type: "submit" }, "Отправить");
  form.append(el("div", { class: "actions" }, button));
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(button, () =>
        submit(
          Object.fromEntries(
            Object.entries(inputs).map(([k, v]) => [k, v.value]),
          ),
        ),
      );
      toast("Сохранено");
    } catch (error) {
      toast(friendly(error));
    }
  };
  return form;
}
function reasonDialog(title, fn) {
  const form = formBox(
    title,
    [{ name: "reason", label: "Причина решения", type: "textarea" }],
    async (data) => {
      await fn(data.reason);
      document.querySelector("#modal").close();
    },
  );
  modal(form);
}
export async function civic(app, session) {
  app.append(el("h1", {}, "Мэрия и обращения"));
  const roles = await rows("user_roles");
  const isMayor = roles.some(
    (r) => r.user_id === session.user.id && r.role === "mayor",
  );
  const form = formBox(
    "Подать заявление",
    [
      { name: "title", label: "Тема" },
      { name: "body", label: "Содержание", type: "textarea" },
    ],
    async (data) => {
      await unwrap(
        client
          .from("applications")
          .insert({ applicant_id: session.user.id, kind: kind.value, ...data }),
      );
      await refresh();
    },
  );
  const kind = el(
    "select",
    { "aria-label": "Тип заявления" },
    ...Object.entries({
      verification: "Подтвердить жителя",
      business: "Открыть бизнес",
      permit: "Внутреннее разрешение",
      initiative: "Инициатива",
      support: "Помощь",
    }).map(([value, text]) => el("option", { value }, text)),
  );
  form.prepend(el("label", {}, "Тип заявления"), kind);
  app.append(card(form));
  const container = el("div", { class: "section" });
  app.append(container);
  async function refresh() {
    const apps = await unwrap(
      client
        .from("applications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    );
    container.replaceChildren(
      el("h2", {}, isMayor ? "Очередь заявлений" : "Мои заявления"),
    );
    for (const a of apps) {
      const node = card(
        el("h3", {}, a.title),
        el("span", { class: "tag" }, labels[a.status]),
        el("p", { class: "post-body" }, a.body),
        el("p", {}, a.decision ?? ""),
      );
      if (
        isMayor &&
        a.status === "pending" &&
        a.applicant_id !== session.user.id
      )
        node.append(
          el(
            "div",
            { class: "actions" },
            ...[
              [true, "Одобрить"],
              [false, "Отклонить"],
            ].map(([approve, text]) =>
              action(text, () =>
                reasonDialog(text, async (reason) => {
                  await rpc("review_application", {
                    p_id: a.id,
                    p_approve: approve,
                    p_reason: reason,
                  });
                  await refresh();
                }),
              ),
            ),
          ),
        );
      container.append(node);
    }
    if (!apps.length) container.append(empty("Заявлений пока нет"));
  }
  await refresh();
  app.append(
    el("h2", { class: "section" }, "Внутренняя служба помощи"),
    el(
      "p",
      { class: "notice" },
      "Обращение получают участники платформы. Это не государственная экстренная служба.",
    ),
  );
  const help = formBox(
    "Обращение",
    [
      {
        name: "body",
        label: "Описание ситуации без медицинских документов",
        type: "textarea",
      },
    ],
    async (data) => {
      await unwrap(
        client.from("service_requests").insert({
          author_id: session.user.id,
          service: service.value,
          ...data,
        }),
      );
      await refreshRequests();
    },
  );
  const service = el(
    "select",
    { "aria-label": "Служба" },
    el("option", { value: "ksb" }, "КСБ"),
    el("option", { value: "hospital" }, "Больница"),
    el("option", { value: "police" }, "Полиция"),
  );
  help.prepend(service);
  app.append(card(help));
  const queue = el("div");
  app.append(queue);
  async function refreshRequests() {
    queue.replaceChildren();
    for (const r of await rows("service_requests")) {
      const node = card(
        el("strong", {}, r.id.slice(0, 8)),
        el("span", { class: "tag" }, labels[r.status]),
        el("p", {}, r.body),
        el("p", {}, r.result ?? ""),
      );
      const staff =
        isMayor ||
        roles.some(
          (x) =>
            x.user_id === session.user.id &&
            x.role === (r.service === "hospital" ? "doctor" : r.service),
        );
      if (staff && r.status === "new")
        node.append(
          action("Принять обращение", async () => {
            await rpc("handle_request", { p_id: r.id, p_close: false });
            await refreshRequests();
          }),
        );
      if (
        staff &&
        r.status === "accepted" &&
        (isMayor || r.assignee_id === session.user.id)
      )
        node.append(
          action("Закрыть с результатом", () =>
            reasonDialog("Результат обращения", async (result) => {
              await rpc("handle_request", {
                p_id: r.id,
                p_close: true,
                p_result: result,
              });
              await refreshRequests();
            }),
          ),
        );
      queue.append(node);
    }
  }
  await refreshRequests();
}
export async function businesses(app, session) {
  app.append(
    el("h1", {}, "Бизнесы Капани"),
    el("a", { class: "button", href: "#civic" }, "Подать заявку на открытие"),
  );
  const list = await rows("businesses");
  const grid = el("div", { class: "grid" });
  for (const b of list) {
    const node = card(
      el("h3", {}, b.name),
      el("p", {}, b.description),
      el("p", { class: "small" }, b.address || "Адрес не указан"),
    );
    if (b.owner_id === session.user.id) {
      const account = await unwrap(
        client
          .from("accounts")
          .select("balance")
          .eq("id", b.account_id)
          .single(),
      );
      node.append(
        el("div", { class: "money" }, formatMoney(account.balance)),
        action("Счёт и сотрудники", () => businessPanel(b)),
        action("Изменить описание", () => {
          const f = formBox(
            "Описание организации",
            [
              {
                name: "description",
                label: "Описание",
                type: "textarea",
                value: b.description,
              },
              { name: "address", label: "Адрес", value: b.address },
            ],
            async (values) => {
              await unwrap(
                client.from("businesses").update(values).eq("id", b.id),
              );
              document.querySelector("#modal").close();
              location.reload();
            },
          );
          modal(f);
        }),
        el(
          "a",
          { class: "button quiet", href: "#jobs" },
          "Вакансии и сотрудники",
        ),
      );
    }
    grid.append(node);
  }
  app.append(grid);
  if (!list.length) app.append(empty("Здесь появятся одобренные организации"));
}
export async function jobs(app, session) {
  app.append(el("h1", {}, "Работа рядом"));
  const [vacancies, businessList, roles] = await Promise.all([
    rows("vacancies"),
    rows("businesses"),
    rows("user_roles"),
  ]);
  const mine = businessList.filter((b) => b.owner_id === session.user.id);
  const mayor = roles.some(
    (r) => r.user_id === session.user.id && r.role === "mayor",
  );
  if (mayor || mine.length) {
    const form = formBox(
      "Открыть вакансию",
      [
        { name: "title", label: "Должность" },
        {
          name: "description",
          label: "Требования и условия",
          type: "textarea",
        },
        {
          name: "positions",
          label: "Количество мест",
          type: "number",
          value: "1",
        },
        {
          name: "salary",
          label: "Оплата за расчётный период в К₽",
          value: "0",
        },
      ],
      async (data) => {
        await rpc("create_vacancy", {
          p_business: org.value || null,
          p_title: data.title,
          p_description: data.description,
          p_positions: Number(data.positions),
          p_salary: data.salary === "0" ? "0" : parseMoney(data.salary),
          p_role: org.value ? null : role.value || null,
        });
        location.reload();
      },
    );
    const org = el(
      "select",
      { "aria-label": "Работодатель" },
      ...(mayor ? [el("option", { value: "" }, "Мэрия")] : []),
      ...mine.map((b) => el("option", { value: b.id }, b.name)),
    );
    const role = el(
      "select",
      { "aria-label": "Муниципальная роль" },
      el("option", { value: "" }, "Без глобальных полномочий"),
      ...[
        "driver",
        "courier",
        "doctor",
        "assistant",
        "cleaner",
        "journalist",
        "advertiser",
        "ksb",
        "police",
        "deputy",
        "moderator",
      ].map((r) => el("option", { value: r }, r)),
    );
    form.prepend(org, role);
    app.append(card(form));
  }
  const grid = el("div", { class: "grid" });
  for (const v of vacancies.filter((x) => x.active)) {
    const node = card(
      el("h3", {}, v.title),
      el("p", {}, v.description),
      el("p", {}, formatMoney(v.salary)),
      action("Откликнуться", () => {
        modal(
          formBox(
            "Отклик",
            [{ name: "letter", label: "Расскажи о себе", type: "textarea" }],
            async (data) => {
              await unwrap(
                client.from("job_applications").insert({
                  vacancy_id: v.id,
                  applicant_id: session.user.id,
                  letter: data.letter,
                }),
              );
              document.querySelector("#modal").close();
              location.reload();
            },
          ),
        );
      }),
    );
    if (v.required_exam_id)
      node.append(
        el(
          "a",
          { href: "#education" },
          "Для должности требуется внутренний экзамен",
        ),
      );
    if (mayor || mine.some((b) => b.id === v.business_id))
      node.append(
        action("Требование к экзамену", async () => {
          const exams = await rows("exams");
          const selector = el(
            "select",
            { "aria-label": "Экзамен" },
            el("option", { value: "" }, "Без экзамена"),
            ...exams.map((e) => el("option", { value: e.id }, e.title)),
          );
          selector.value = v.required_exam_id ?? "";
          modal(
            el("h2", {}, "Допуск к должности"),
            selector,
            action("Сохранить", async () => {
              await rpc("vacancy_exam_requirement", {
                p_vacancy: v.id,
                p_exam: selector.value || null,
              });
              document.querySelector("#modal").close();
              location.reload();
            }),
          );
        }),
      );
    grid.append(node);
  }
  app.append(grid, el("h2", { class: "section" }, "Отклики"));
  for (const j of await rows(
    "job_applications",
    "*,vacancies(title,business_id)",
  )) {
    const node = card(
      el("h3", {}, j.vacancies.title),
      el("span", { class: "tag" }, labels[j.status]),
      el("p", {}, j.letter),
      el("p", {}, j.decision ?? ""),
    );
    if (
      j.applicant_id !== session.user.id &&
      j.status === "pending" &&
      (mayor || mine.some((b) => b.id === j.vacancies.business_id))
    )
      for (const [accept, label] of [
        [true, "Принять"],
        [false, "Отклонить"],
      ])
        node.append(
          action(label, () =>
            reasonDialog(label, async (reason) => {
              await rpc("review_job", {
                p_id: j.id,
                p_accept: accept,
                p_reason: reason,
              });
              location.reload();
            }),
          ),
        );
    if (
      (j.applicant_id === session.user.id &&
        ["pending", "accepted"].includes(j.status)) ||
      (j.status === "accepted" &&
        (mayor || mine.some((b) => b.id === j.vacancies.business_id)))
    )
      node.append(
        action(
          j.applicant_id === session.user.id
            ? j.status === "pending"
              ? "Отозвать отклик"
              : "Уволиться"
            : "Завершить работу сотрудника",
          () =>
            reasonDialog("Причина", async (reason) => {
              await rpc("end_employment", {
                p_application: j.id,
                p_reason: reason,
              });
              location.reload();
            }),
        ),
      );
    app.append(node);
  }
}
export async function clinic(app, session) {
  app.append(
    el("h1", {}, "Лёхин шалаш"),
    el(
      "p",
      {},
      "Внутренняя онлайн-запись Капани. Здесь не хранятся диагнозы или медицинские документы.",
    ),
  );
  const [services, slots, appointments, roles] = await Promise.all([
    rows("clinic_services"),
    rpc("available_clinic_slots", {}),
    rows(
      "appointments",
      "*,clinic_slots(starts_at,doctor_id),clinic_services(title)",
    ),
    rows("user_roles"),
  ]);
  if (roles.some((r) => r.user_id === session.user.id && r.role === "doctor")) {
    app.append(
      card(
        formBox(
          "Добавить услугу",
          [
            { name: "title", label: "Услуга" },
            { name: "price", label: "Стоимость К₽", value: "0" },
          ],
          async (data) => {
            await rpc("create_clinic_service", {
              p_title: data.title,
              p_price: data.price === "0" ? "0" : parseMoney(data.price),
            });
            location.reload();
          },
        ),
      ),
      card(
        formBox(
          "Открыть время приёма",
          [
            {
              name: "start",
              label: "Начало — в :00 или :30, время твоего устройства",
              type: "datetime-local",
            },
          ],
          async (data) => {
            await rpc("create_clinic_slot", {
              p_start: new Date(data.start).toISOString(),
            });
            location.reload();
          },
        ),
      ),
    );
  }
  const grid = el("div", { class: "grid" });
  for (const s of services.filter((s) => s.active)) {
    const node = card(el("h3", {}, s.title), el("p", {}, formatMoney(s.price)));
    const choices = slots.filter((t) => t.doctor_id === s.doctor_id);
    if (choices.length) {
      const choice = el(
        "select",
        { "aria-label": "Время приёма" },
        ...choices.map((t) =>
          el(
            "option",
            { value: t.id },
            new Date(t.starts_at).toLocaleString("ru-RU"),
          ),
        ),
      );
      let attempt = null;
      node.append(
        choice,
        action("Записаться", async () => {
          if (!attempt || attempt.slot !== choice.value)
            attempt = { slot: choice.value, key: uuid() };
          await rpc("book_appointment", {
            p_service: s.id,
            p_slot: attempt.slot,
            p_key: attempt.key,
          });
          toast("Запись подтверждена");
          location.reload();
        }),
      );
    } else node.append(el("p", {}, "Свободное время пока не опубликовано"));
    grid.append(node);
  }
  app.append(
    grid,
    el(
      "p",
      { class: "small muted" },
      "Доступность времени повторно проверяется сервером при записи.",
    ),
    el("h2", { class: "section" }, "Мои записи"),
  );
  for (const a of appointments) {
    const node = card(
      el("h3", {}, a.clinic_services.title),
      el("p", {}, new Date(a.clinic_slots.starts_at).toLocaleString("ru-RU")),
      el("span", { class: "tag" }, labels[a.status]),
    );
    if (a.status === "booked") {
      node.append(
        action("Отменить запись", async () => {
          await rpc("appointment_action", { p_id: a.id, p_cancel: true });
          location.reload();
        }),
      );
      if (a.clinic_slots.doctor_id === session.user.id)
        node.append(
          action("Завершить приём", async () => {
            await rpc("appointment_action", { p_id: a.id, p_cancel: false });
            location.reload();
          }),
        );
    }
    app.append(node);
  }
}
