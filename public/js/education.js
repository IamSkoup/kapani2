import { client, unwrap, rpc, friendly } from "./api.js";
import { el, card, field, modal, empty, busy, toast } from "./ui.js";
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
export async function educationPage(app, session) {
  let timer = null,
    disposed = false;
  const roles = await unwrap(
      client.from("user_roles").select("role").eq("user_id", session.user.id),
    ),
    mayor = roles.some((r) => r.role === "mayor");
  app.append(
    el("h1", {}, "К-образование"),
    el(
      "p",
      {},
      "Капанёвский внутренний экзамен. Результаты относятся только к платформе и не заменяют государственные документы.",
    ),
  );
  const catalogue = el("div", { class: "grid" }),
    workspace = el("section", { class: "section" }),
    history = el("section", { class: "section" });
  app.append(catalogue, workspace, history);
  if (mayor) app.prepend(action("Создать экзамен", () => examEditor()));
  async function refresh() {
    const [exams, attempts] = await Promise.all([
      unwrap(
        client
          .from("exams")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
      ),
      unwrap(
        client
          .from("exam_attempts")
          .select("*,exams(title)")
          .order("started_at", { ascending: false })
          .limit(50),
      ),
    ]);
    if (disposed) return;
    catalogue.replaceChildren(
      ...exams.map((exam) => {
        const node = card(
          el("span", { class: "tag" }, exam.active ? "Доступен" : "Подготовка"),
          el("h2", {}, exam.title),
          el(
            "p",
            {},
            `${exam.question_count} вопросов · ${Math.round(exam.duration_seconds / 60)} мин · проходной результат ${exam.pass_percent}%`,
          ),
          el("p", {}, formatMoney(exam.fee)),
        );
        if (exam.active) {
          const running = attempts.find(
            (a) =>
              a.exam_id === exam.id &&
              a.user_id === session.user.id &&
              a.status === "running",
          );
          let key = uuid();
          node.append(
            action(
              running ? "Продолжить попытку" : "Начать экзамен",
              async () => {
                if (
                  !running &&
                  !confirm(
                    "Начать попытку? Время начнётся сразу. Стоимость " +
                      formatMoney(exam.fee),
                  )
                )
                  return;
                const attempt =
                  running ??
                  (await rpc("start_exam", { p_exam: exam.id, p_key: key }));
                await openAttempt(attempt);
                await refresh();
              },
            ),
          );
        }
        if (mayor)
          node.append(
            action("Настройки", () => examEditor(exam)),
            action("Добавить вопрос", () => questionEditor(exam)),
          );
        return node;
      }),
    );
    if (!exams.length)
      catalogue.append(empty("Мэрия ещё не опубликовала экзамены"));
    history.replaceChildren(el("h2", {}, "История попыток"));
    for (const a of attempts) {
      const own = a.user_id === session.user.id,
        node = card(
          el("h3", {}, a.exams.title),
          el("p", {}, new Date(a.started_at).toLocaleString("ru-RU")),
          el(
            "p",
            {},
            a.status === "running"
              ? "Попытка выполняется"
              : `${a.score} из ${a.question_count} · ${a.passed ? "экзамен сдан" : "не сдан"}`,
          ),
        );
      if (a.status === "running" && own)
        node.append(action("Продолжить", () => openAttempt(a)));
      if (a.status === "finished")
        node.append(action("Подробный результат", () => showResult(a)));
      history.append(node);
    }
  }
  async function showResult(a) {
    const [details, adjustments] = await Promise.all([
      rpc("exam_result", { p_attempt: a.id }),
      unwrap(
        client
          .from("exam_adjustments")
          .select("*")
          .eq("attempt_id", a.id)
          .order("created_at", { ascending: false }),
      ),
    ]);
    const content = el(
      "div",
      {},
      el("h2", {}, "Результат экзамена"),
      el("p", {}, `${a.score} из ${a.question_count}`),
    );
    if (adjustments.length)
      content.append(
        el(
          "p",
          { class: "notice" },
          `Скорректированный результат ${adjustments[0].score} из ${a.question_count}. Причина — ${adjustments[0].reason}`,
        ),
      );
    for (const d of details)
      content.append(
        card(
          el("h3", {}, d.prompt),
          el(
            "p",
            {},
            d.selected_id === d.correct_id
              ? "Верно"
              : d.selected_id
                ? "Неверно"
                : "Ответ не выбран",
          ),
          el("p", {}, d.explanation),
        ),
      );
    if (mayor && a.user_id !== session.user.id)
      content.append(
        action("Скорректировать с обоснованием", () => {
          const form = el("form", {}, el("h2", {}, "Корректировка")),
            score = field(
              form,
              "Число верных ответов",
              "score",
              "number",
              String(a.score),
            ),
            reason = field(
              form,
              "Причина — минимум 10 символов",
              "reason",
              "textarea",
            ),
            save = el("button", { type: "submit" }, "Подтвердить");
          score.min = 0;
          score.max = a.question_count;
          reason.minLength = 10;
          form.append(save);
          modal(form);
          form.onsubmit = async (e) => {
            e.preventDefault();
            try {
              await busy(save, () =>
                rpc("correct_exam_result", {
                  p_attempt: a.id,
                  p_score: Number(score.value),
                  p_reason: reason.value,
                }),
              );
              document.querySelector("#modal").close();
              toast("Корректировка записана в аудит");
            } catch (error) {
              toast(friendly(error));
            }
          };
        }),
      );
    modal(content);
  }
  async function openAttempt(a) {
    clearInterval(timer);
    workspace.replaceChildren();
    if (a.status === "finished") {
      await showResult(a);
      return;
    }
    const [questions, answers] = await Promise.all([
      rpc("exam_questions", { p_attempt: a.id }),
      unwrap(client.from("exam_answers").select("*").eq("attempt_id", a.id)),
    ]);
    if (disposed) return;
    const clock = el("p", { class: "notice" }),
      form = el("form"),
      pending = new Set(),
      submit = el("button", { type: "submit" }, "Завершить экзамен");
    workspace.append(el("h2", {}, "Текущая попытка"), clock, form);
    const updateClock = () => {
      const seconds = Math.max(
        0,
        Math.floor((new Date(a.deadline) - Date.now()) / 1000),
      );
      clock.textContent = seconds
        ? `Осталось ${Math.floor(seconds / 60)} мин ${seconds % 60} с. Отсчёт на экране ориентировочный; срок проверяет сервер.`
        : "Время завершилось. Новые ответы не принимаются.";
      if (!seconds) {
        form.querySelectorAll("input").forEach((i) => (i.disabled = true));
        clearInterval(timer);
      }
    };
    updateClock();
    timer = setInterval(updateClock, 1000);
    for (const q of questions) {
      const box = el(
          "fieldset",
          { class: "card" },
          el("legend", {}, `${q.position}. ${q.prompt}`),
        ),
        saved = el(
          "small",
          { class: "muted" },
          answers.some((x) => x.question_id === q.question_id)
            ? "Ответ сохранён"
            : "Выбери ответ",
        );
      for (const o of q.options) {
        const radio = el("input", {
          type: "radio",
          name: q.question_id,
          value: o.id,
        });
        radio.checked = answers.some(
          (x) => x.question_id === q.question_id && x.option_id === o.id,
        );
        radio.onchange = async () => {
          pending.add(q.question_id);
          submit.disabled = true;
          box.querySelectorAll("input").forEach((i) => (i.disabled = true));
          try {
            await rpc("answer_exam", {
              p_attempt: a.id,
              p_question: q.question_id,
              p_option: o.id,
            });
            saved.textContent = "Ответ сохранён сервером";
          } catch (error) {
            saved.textContent = friendly(error);
            radio.checked = false;
          } finally {
            pending.delete(q.question_id);
            submit.disabled = pending.size > 0;
            if (new Date(a.deadline) > new Date())
              box
                .querySelectorAll("input")
                .forEach((i) => (i.disabled = false));
          }
        };
        box.append(
          el("label", { class: "choice" }, radio, el("span", {}, o.body)),
        );
      }
      box.append(saved);
      form.append(box);
    }
    form.append(submit);
    updateClock();
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (
        pending.size ||
        !confirm("Завершить попытку? После этого ответы нельзя изменить.")
      )
        return;
      try {
        await busy(submit, async () => {
          const result = await rpc("submit_exam", { p_attempt: a.id });
          clearInterval(timer);
          workspace.replaceChildren();
          await refresh();
          await showResult(result);
        });
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  function examEditor(exam = null) {
    const f = el("form", {}, el("h2", {}, "Настройка экзамена")),
      title = field(f, "Название", "title", "text", exam?.title ?? ""),
      duration = field(
        f,
        "Длительность в минутах",
        "duration",
        "number",
        String((exam?.duration_seconds ?? 1200) / 60),
      ),
      count = field(
        f,
        "Вопросов в попытке",
        "count",
        "number",
        String(exam?.question_count ?? 5),
      ),
      pass = field(
        f,
        "Проходной процент",
        "pass",
        "number",
        String(exam?.pass_percent ?? 70),
      ),
      fee = field(
        f,
        "Стоимость в К₽",
        "fee",
        "text",
        String((exam?.fee ?? 0) / 100),
      ),
      active = el(
        "select",
        { "aria-label": "Доступность" },
        el("option", { value: "false" }, "Подготовка"),
        el("option", { value: "true" }, "Доступен жителям"),
      ),
      save = el("button", { type: "submit" }, "Сохранить");
    active.value = String(exam?.active ?? false);
    f.append(
      active,
      el(
        "p",
        { class: "small" },
        "Сначала сохрани экзамен в подготовке и добавь вопросы. Настройки не меняют уже начатые попытки.",
      ),
      save,
    );
    const id = exam?.id ?? uuid();
    modal(f);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(save, () =>
          rpc("save_exam", {
            p_id: id,
            p_title: title.value,
            p_seconds: Number(duration.value) * 60,
            p_questions: Number(count.value),
            p_pass: Number(pass.value),
            p_fee: fee.value === "0" ? "0" : parseMoney(fee.value),
            p_active: active.value === "true",
          }),
        );
        document.querySelector("#modal").close();
        await refresh();
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  function questionEditor(exam) {
    const f = el("form", {}, el("h2", {}, "Вопрос для " + exam.title)),
      prompt = field(f, "Вопрос", "prompt", "textarea"),
      options = field(
        f,
        "От 2 до 8 вариантов, каждый с новой строки",
        "options",
        "textarea",
      ),
      correct = field(
        f,
        "Номер правильного варианта",
        "correct",
        "number",
        "1",
      ),
      explanation = field(
        f,
        "Объяснение после завершения попытки",
        "explanation",
        "textarea",
      ),
      save = el("button", { type: "submit" }, "Добавить");
    f.append(save);
    const id = uuid();
    modal(f);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await busy(save, () =>
          rpc("add_exam_question", {
            p_id: id,
            p_exam: exam.id,
            p_prompt: prompt.value,
            p_options: options.value
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean),
            p_correct: Number(correct.value),
            p_explanation: explanation.value,
          }),
        );
        document.querySelector("#modal").close();
        toast("Вопрос сохранён");
      } catch (error) {
        toast(friendly(error));
      }
    };
  }
  await refresh();
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
