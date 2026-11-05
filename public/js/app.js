import { taxiPage } from "./taxi.js";
import { mapPage } from "./map.js";
import { shopPage } from "./shop.js";
import { tasksPage } from "./tasks.js";
import { rentalsPage } from "./rentals.js";
import { notificationsPage } from "./notifications.js";
import { educationPage } from "./education.js";
import { newsPage, eventsPage } from "./publishing.js";
import { messenger } from "./messenger.js";
import { uploadFile, prepareFiles } from "./uploads.js";
import { subscriptions } from "./subscriptions.js";
import { uuid } from "./id.js";
import { civic, businesses, jobs, clinic } from "./civic.js";
import { market } from "./market.js";
import { initialize, client, unwrap, rpc, friendly, signIn } from "./api.js";
import { el, card, toast, busy, field, empty, modal } from "./ui.js";
import { formatMoney, parseMoney } from "./money.js";
const root = document.querySelector("#app");
let session = null,
  profile = null,
  cleanup = () => {},
  revision = 0;
const serviceNames = ["Такси", "Доставка", "Автошкола", "Лесной клуб"];
const button = (text, fn, cls = "") =>
  el(
    "button",
    {
      class: cls,
      type: "button",
      onClick: async (e) => {
        try {
          await busy(e.currentTarget, fn);
        } catch (error) {
          toast(friendly(error));
        }
      },
    },
    text,
  );
const query = (table, columns = "*") => client.from(table).select(columns);
function showError(error) {
  root.replaceChildren(
    el("h2", {}, "Не удалось загрузить раздел"),
    el("p", { class: "error" }, friendly(error)),
    button("Попробовать снова", render),
  );
}
function requireAuth(app) {
  if (!session) {
    auth(app);
    return false;
  }
  return true;
}
function auth(app = root) {
  const form = el("form", { class: "auth" });
  form.append(
    el("span", { class: "eyebrow" }, "ДОБРО ПОЖАЛОВАТЬ ДОМОЙ"),
    el("h2", {}, "Войти в Капани"),
  );
  const mail = field(form, "Почта или никнейм", "identifier", "text");
  mail.autocomplete = "username";
  const pass = field(form, "Пароль", "password", "password");
  pass.autocomplete = "current-password";
  const submit = el("button", { type: "submit" }, "Войти");
  form.append(
    el(
      "div",
      { class: "actions" },
      submit,
      button("Создать аккаунт", () => signup(app), "quiet"),
      button(
        "Восстановить пароль",
        async () => {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.value.trim()))
            throw Error("Укажи электронную почту");
          await unwrap(
            client.auth.resetPasswordForEmail(mail.value, {
              redirectTo: location.href.split("#")[0] + "#recovery",
            }),
          );
          toast("Если адрес зарегистрирован, на него придёт письмо.");
        },
        "quiet",
      ),
    ),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(submit, async () => {
        await signIn(mail.value, pass.value);
        location.hash = "home";
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  app.replaceChildren(
    el(
      "section",
      { class: "auth-scene" },
      el(
        "div",
        { class: "auth-photo" },
        el("img", {
          src: "./assets/forest-road.webp",
          alt: "Дорога среди хвойного леса",
          width: "1536",
          height: "1024",
        }),
        el(
          "div",
          { class: "auth-photo-copy" },
          el("span", { class: "eyebrow" }, "Капани · среди лесов"),
          el("h1", {}, "Здесь свои."),
          el("p", {}, "Место, где знакомые дороги становятся ближе."),
        ),
      ),
      form,
    ),
  );
}
function signup(app = root) {
  const form = el("form", { class: "auth" }, el("h2", {}, "Стать жителем"));
  const username = field(form, "Никнейм", "username");
  username.minLength = 3;
  username.maxLength = 32;
  const email = field(form, "Почта", "email", "email");
  const password = field(
    form,
    "Пароль — минимум 12 символов",
    "password",
    "password",
  );
  password.minLength = 12;
  const submit = el("button", { type: "submit" }, "Зарегистрироваться");
  form.append(
    el(
      "p",
      { class: "small" },
      "Почту нужно подтвердить. Социальное общение доступно без подтверждения мэрии.",
    ),
    submit,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(submit, async () => {
        await unwrap(
          client.auth.signUp({
            email: email.value,
            password: password.value,
            options: {
              data: { username: username.value },
              emailRedirectTo: location.href.split("#")[0],
            },
          }),
        );
        toast("Проверь почту для завершения регистрации.");
        auth(app);
      });
    } catch {
      toast(
        "Регистрация не завершена. Проверь данные или попробуй восстановить доступ.",
      );
    }
  };
  app.replaceChildren(
    el(
      "section",
      { class: "auth-scene" },
      el(
        "div",
        { class: "auth-photo" },
        el("img", {
          src: "./assets/forest-road.webp",
          alt: "Дорога среди хвойного леса",
          width: "1536",
          height: "1024",
        }),
        el(
          "div",
          { class: "auth-photo-copy" },
          el("span", { class: "eyebrow" }, "Капани · среди лесов"),
          el("h1", {}, "Здесь свои."),
          el("p", {}, "Место, где знакомые дороги становятся ближе."),
        ),
      ),
      form,
    ),
  );
}
async function home(app = root) {
  const hero = el(
    "section",
    { class: "hero" },
    el(
      "div",
      {},
      el("span", { class: "eyebrow" }, "СВОИ ЛЮДИ. СВОИ МЕСТА."),
      el(
        "h1",
        {},
        profile
          ? `С возвращением, ${profile.display_name}.`
          : "Посёлок маленький.\nВозможности — большие.",
      ),
      el(
        "p",
        {},
        "Общайся с соседями, открывай своё дело и участвуй в жизни Капани. Всё, что связывает нас, — в одном месте.",
      ),
      el(
        "div",
        { class: "actions" },
        el("a", { class: "button", href: "#chat" }, "В общий чат"),
        el(
          "a",
          { class: "button quiet", href: "#services" },
          "Сервисы посёлка",
        ),
      ),
    ),
    el(
      "div",
      { class: "hero-art" },
      el("img", {
        src: "./assets/forest-road.webp",
        alt: "Лесная дорога Капани",
        width: "1536",
        height: "1024",
      }),
      el("span", {}, "Капани"),
      el("small", {}, "Дом среди лесов"),
    ),
  );
  app.append(hero);
  if (session) {
    const accounts = await unwrap(query("accounts"));
    app.append(
      el(
        "div",
        { class: "grid" },
        ...accounts.map((a) =>
          card(
            el(
              "span",
              { class: "muted" },
              a.kind === "wallet" ? "Мой кошелёк" : "Накопительный счёт",
            ),
            el("div", { class: "money" }, formatMoney(a.balance)),
            el("a", { href: "#bank" }, "Открыть банк →"),
          ),
        ),
        card(
          el(
            "span",
            { class: "tag" },
            profile.verified ? "Житель подтверждён" : "Ожидает подтверждения",
          ),
          el(
            "p",
            {},
            "Общение доступно сразу. Для операций экономики требуется подтверждение мэрии.",
          ),
        ),
      ),
    );
    const notes = await unwrap(
      query("notifications").order("created_at", { ascending: false }).limit(5),
    );
    app.append(
      el(
        "section",
        { class: "section" },
        el("h2", {}, "Важное для тебя"),
        el("a", { href: "#notifications" }, "Все уведомления"),
        ...notes.map((n) =>
          card(el("a", { href: n.href ?? "#home" }, n.title)),
        ),
        ...(!notes.length ? [empty("Новых уведомлений пока нет")] : []),
      ),
    );
  }
  app.append(
    el(
      "section",
      { class: "section" },
      el(
        "div",
        { class: "row" },
        el("h2", {}, "Жизнь посёлка"),
        el("a", { href: "#services" }, "Все сервисы →"),
      ),
      el(
        "div",
        { class: "grid" },
        ...["Сообщения", "Банк Капани", "Лента жителей"].map((t, i) =>
          el(
            "a",
            { class: "card", href: ["#chat", "#bank", "#feed"][i] },
            el("h3", {}, t),
            el(
              "p",
              {},
              [
                "Всегда рядом, даже на расстоянии.",
                "Внутренняя экономика с историей операций.",
                "Истории, планы и новости соседей.",
              ][i],
            ),
          ),
        ),
      ),
    ),
  );
}
async function feed(app = root) {
  if (!requireAuth(app)) return;
  app.append(el("h1", {}, "Соседи на связи"));
  const form = el("form", {}, el("h3", {}, "Что происходит в Капани?"));
  const text = field(form, "Твоя публикация", "body", "textarea");
  text.maxLength = 20000;
  const submit = el("button", { type: "submit" }, "Опубликовать");
  form.append(submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(submit, async () => {
        await unwrap(
          client
            .from("posts")
            .insert({ author_id: session.user.id, body: text.value }),
        );
        await render();
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  app.append(card(form));
  const posts = await unwrap(
    query("posts", "*,profiles!author_id(display_name)")
      .order("created_at", { ascending: false })
      .limit(30),
  );
  for (const p of posts) {
    const node = card(
      el(
        "div",
        { class: "row" },
        el("strong", {}, p.profiles?.display_name ?? "Житель"),
        el(
          "span",
          { class: "small muted" },
          new Date(p.created_at).toLocaleString("ru-RU"),
        ),
      ),
      el("p", { class: "post-body" }, p.body),
    );
    if (p.author_id === session.user.id)
      node.append(
        button(
          "Удалить",
          async () => {
            if (!confirm("Удалить свою публикацию?")) return;
            await unwrap(client.from("posts").delete().eq("id", p.id));
            await render();
          },
          "quiet",
        ),
      );
    app.append(node);
  }
  if (!posts.length)
    app.append(empty("Первые истории ещё впереди. Напиши свою."));
}
async function bank(app = root) {
  if (!requireAuth(app)) return;
  app.append(
    el("h1", {}, "Банк Капани"),
    el(
      "p",
      {},
      "Внутренняя валюта посёлка. Без покупки, обмена и вывода настоящих денег.",
    ),
  );
  const accounts = await unwrap(query("accounts"));
  app.append(
    el(
      "div",
      { class: "grid" },
      ...accounts.map((a) =>
        card(
          el("h3", {}, a.kind === "wallet" ? "Основной кошелёк" : "Накопления"),
          el("div", { class: "money" }, formatMoney(a.balance)),
        ),
      ),
    ),
  );
  const form = el(
    "form",
    { class: "card section" },
    el("h2", {}, "Перевести средства"),
  );
  const recipient = field(form, "Никнейм получателя", "recipient");
  const amount = field(form, "Сумма в К₽", "amount");
  amount.inputMode = "decimal";
  const kind = el(
    "select",
    { name: "kind" },
    el("option", { value: "" }, "Другому жителю"),
    el("option", { value: "deposit" }, "На свой накопительный счёт"),
    el("option", { value: "withdraw" }, "С накопительного на основной"),
  );
  form.append(el("label", {}, "Тип операции"), kind);
  kind.onchange = () => {
    recipient.required = !kind.value;
    recipient.disabled = !!kind.value;
  };
  const submit = el("button", { type: "submit" }, "Проверить перевод");
  form.append(el("div", { class: "actions" }, submit));
  let pending = null;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        p_recipient: recipient.value,
        p_amount: parseMoney(amount.value),
        p_savings: kind.value || null,
      };
      const fingerprint = JSON.stringify(payload);
      if (pending?.fingerprint !== fingerprint)
        pending = { fingerprint, key: uuid() };
      const d = modal(
        el("h2", {}, "Подтверждение перевода"),
        el(
          "p",
          {},
          `Сумма ${formatMoney(payload.p_amount)}. Комиссия текущей реализации — 0 К₽.`,
        ),
        button("Подтвердить", async () => {
          const id = await rpc("transfer", { ...payload, p_key: pending.key });
          pending = null;
          d.close();
          toast("Квитанция " + id);
          await render();
        }),
      );
    } catch (error) {
      toast(friendly(error));
    }
  };
  app.append(form, el("h2", { class: "section" }, "История операций"));
  const entries = await unwrap(
    query(
      "entries",
      "id,amount,account_id,transactions!transaction_id(id,kind,created_at)",
    )
      .order("id", { ascending: false })
      .limit(40),
  );
  app.append(
    ...entries.map((e) =>
      card(
        el(
          "div",
          { class: "row" },
          el(
            "span",
            {},
            new Date(e.transactions.created_at).toLocaleString("ru-RU"),
          ),
          el("strong", {}, formatMoney(e.amount)),
        ),
        el("small", { class: "muted" }, e.transactions.id),
      ),
    ),
    ...(!entries.length ? [empty("Операций ещё не было")] : []),
  );
}
async function chat(app) {
  if (!requireAuth(app)) return;
  const requested = new URLSearchParams(location.hash.split("?")[1] ?? "").get(
    "conversation",
  );
  const initial = requested
    ? await unwrap(query("conversations").eq("id", requested).single())
    : null;
  const dispose = await messenger(app, session, initial);
  if (!app.isConnected) {
    dispose();
    return;
  }
  cleanup = dispose;
}
async function services(app = root) {
  app.append(
    el(
      "div",
      { class: "actions" },
      ...Object.entries({
        market: "Маркетплейс",
        civic: "Мэрия",
        businesses: "Бизнесы",
        shop: "Магазины и заказы",
        map: "Карта посёлка",
        taxi: "Такси",
        jobs: "Работа",
        clinic: "Больница",
        subscriptions: "Подписки",
        news: "Новости",
        events: "Мероприятия",
        education: "К-образование",
        rentals: "Аренда зданий",
        tasks: "Задания",
        notifications: "Уведомления",
      }).map(([id, name]) =>
        el("a", { class: "button quiet", href: "#" + id }, name),
      ),
    ),
    el("h1", {}, "Всё рядом"),
    el("p", {}, "Сервисы цифрового посёлка"),
    el(
      "div",
      { class: "notice" },
      "Рабочая сборка первого этапа. Перечисленные ниже разделы ещё не реализованы и не принимают заказы.",
    ),
  );
  const search = el("input", {
      class: "search",
      placeholder: "Найти сервис",
      "aria-label": "Поиск сервиса",
    }),
    grid = el("div", { class: "grid" });
  function draw() {
    grid.replaceChildren(
      ...serviceNames
        .filter((s) => s.toLowerCase().includes(search.value.toLowerCase()))
        .map((s) =>
          card(el("h3", {}, s), el("span", { class: "tag" }, "Следующий этап")),
        ),
    );
  }
  search.oninput = draw;
  draw();
  app.append(search, grid);
}
async function profilePage(app = root) {
  if (!requireAuth(app)) return;
  const form = el("form", { class: "auth" }, el("h2", {}, "Мой профиль"));
  const name = field(
    form,
    "Отображаемое имя",
    "name",
    "text",
    profile.display_name,
  );
  const bio = field(form, "О себе", "bio", "textarea", profile.bio);
  bio.required = false;
  const save = el("button", { type: "submit" }, "Сохранить");
  form.append(save);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(save, async () => {
        await unwrap(
          client
            .from("profiles")
            .update({ display_name: name.value, bio: bio.value })
            .eq("id", session.user.id),
        );
        profile = { ...profile, display_name: name.value, bio: bio.value };
        toast("Профиль сохранён");
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  const avatar = el("input", {
    type: "file",
    accept: ".jpg,.jpeg,.png,.webp",
    "aria-label": "Фото профиля",
  });
  form.append(
    el(
      "p",
      { class: "small" },
      "Фото профиля будет публичным. Изображение до 5 МБ.",
    ),
    avatar,
    button("Загрузить фото", async () => {
      if (!avatar.files.length) throw Error("Выбери изображение");
      const u = await uploadFile(prepareFiles(avatar.files)[0]);
      await rpc("set_avatar", { p_upload: u.id });
      profile.avatar_path = u.path;
      toast("Фото сохранено");
    }),
  );
  form.append(
    button(
      "Выйти",
      async () => {
        await unwrap(client.auth.signOut());
        session = null;
        profile = null;
        location.hash = "home";
        await render();
      },
      "quiet",
    ),
  );
  app.append(form);
}
async function render() {
  const thisRevision = ++revision;
  cleanup();
  cleanup = () => {};
  const app = el("div", { class: "route-frame" });
  root.replaceChildren(app);
  document.querySelector("#account").textContent = session
    ? "Мой профиль"
    : "Войти";
  try {
    if (session && !profile) {
      profile = await unwrap(
        query("profiles").eq("id", session.user.id).single(),
      );
      if (revision !== thisRevision) return;
    }
    const route = location.hash.slice(1).split("?")[0] || "home";
    const routes = {
      taxi: async () => {
        if (requireAuth(app)) {
          const dispose = await taxiPage(app, session);
          if (!app.isConnected) dispose();
          else cleanup = dispose;
        }
      },
      map: async () => {
        if (requireAuth(app)) {
          const dispose = await mapPage(app, session);
          if (!app.isConnected) dispose();
          else cleanup = dispose;
        }
      },
      shop: async () => {
        if (requireAuth(app)) await shopPage(app, session);
      },
      tasks: async () => {
        if (requireAuth(app)) await tasksPage(app, session);
      },
      rentals: async () => {
        if (requireAuth(app)) await rentalsPage(app, session);
      },
      notifications: async () => {
        if (requireAuth(app)) {
          const dispose = await notificationsPage(app);
          if (!app.isConnected) dispose();
          else cleanup = dispose;
        }
      },
      education: async () => {
        if (requireAuth(app)) {
          const dispose = await educationPage(app, session);
          if (!app.isConnected) dispose();
          else cleanup = dispose;
        }
      },
      news: async () => {
        if (requireAuth(app)) await newsPage(app, session);
      },
      events: async () => {
        if (requireAuth(app)) await eventsPage(app, session);
      },
      subscriptions: async () => {
        if (requireAuth(app)) await subscriptions(app, session);
      },
      home,
      feed,
      bank,
      chat,
      services,
      civic: async () => {
        if (requireAuth(app)) await civic(app, session);
      },
      businesses: async () => {
        if (requireAuth(app)) await businesses(app, session);
      },
      jobs: async () => {
        if (requireAuth(app)) await jobs(app, session);
      },
      clinic: async () => {
        if (requireAuth(app)) await clinic(app, session);
      },
      market: async () => {
        if (requireAuth(app)) await market(app, session);
      },
      recovery: recovery,
      profile: profilePage,
      auth,
    };
    await (routes[route] ?? home)(app);
  } catch (error) {
    if (revision === thisRevision) showError(error);
  }
}
document.querySelector("#close").onclick = () =>
  document.querySelector("#modal").close();
document.querySelector("#account").onclick = () => {
  location.hash = session ? "profile" : "auth";
};
window.addEventListener("hashchange", render);
function network() {
  document.querySelector("#network").hidden = navigator.onLine;
}
window.addEventListener("online", network);
window.addEventListener("offline", network);
network();
try {
  if (await initialize()) {
    session = (await unwrap(client.auth.getSession())).session;
    client.auth.onAuthStateChange((event, s) => {
      const changed = session?.user.id !== s?.user.id;
      session = s;
      if (changed) profile = null;
      if (event === "PASSWORD_RECOVERY") {
        location.hash = "recovery";
        return;
      }
      if (changed || event === "SIGNED_OUT") setTimeout(render, 0);
    });
    await render();
  } else {
    root.replaceChildren(
      el(
        "section",
        { class: "hero" },
        el(
          "div",
          {},
          el("span", { class: "eyebrow" }, "КАПАНИ · НОВОЕ НАЧАЛО"),
          el("h1", {}, "Свои люди.\nСвои места."),
          el("p", {}, "Новая цифровая инфраструктура посёлка."),
          el(
            "div",
            { class: "notice" },
            "Подключение не завершено. В конфигурации отсутствует публичный ключ нового Supabase. Регистрация, сообщения и финансовые операции пока недоступны.",
          ),
        ),
        el(
          "div",
          { class: "hero-art" },
          el("span", {}, "Капани"),
          el("small", {}, "ДОМ СРЕДИ ЛЕСОВ"),
        ),
      ),
    );
    document.querySelector("#account").disabled = true;
    document.querySelector("nav").hidden = true;
  }
} catch (error) {
  showError(error);
}
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch(() => {});

function recovery(app = root) {
  const form = el("form", { class: "auth" }, el("h2", {}, "Новый пароль"));
  const password = field(
    form,
    "Пароль — минимум 12 символов",
    "password",
    "password",
  );
  password.minLength = 12;
  const submit = el("button", { type: "submit" }, "Сохранить пароль");
  form.append(submit);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await busy(submit, async () => {
        await unwrap(client.auth.updateUser({ password: password.value }));
        toast("Пароль обновлён");
        location.hash = "home";
      });
    } catch (error) {
      toast(friendly(error));
    }
  };
  app.append(form);
}
